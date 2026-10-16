package rocks.shy.vacuumtube.android;

import android.content.Context;
import android.net.wifi.WifiManager;
import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.net.DatagramPacket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.MulticastSocket;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Enumeration;
import java.util.Locale;

/**
 * Native DIAL (Discovery And Launch) service, replacing src/preload/modules/h5vcc/dial/**
 * (census.md §1.4, §6.4). A WebView page cannot open UDP multicast sockets or listen on TCP, so:
 *
 *   - SSDP M-SEARCH on 239.255.255.250:1900  -> discover.js + net.js
 *   - HTTP device description + /apps routes -> http.js
 *   - the DIAL application handlers          -> stayed in JS (Leanback registers them through
 *                                               window.h5vcc.dial.DialServer); requests are
 *                                               forwarded into the page via __vtDialDispatch.
 *
 * Honour's config.device_discoverability (h5vcc/index.js:37): start() is only called when the
 * page decides to, exactly like the original.
 */
public class VtDial {

    private static final String TAG = "VacuumTube/DIAL";
    private static final String SSDP_ADDRESS = "239.255.255.250";
    private static final int SSDP_PORT = 1900;
    private static final String DIAL_ST = "urn:dial-multiscreen-org:service:dial:1";

    private final MainActivity activity;
    private final String uuid;

    private volatile boolean running;
    private Thread ssdpThread;
    private Thread httpThread;
    private MulticastSocket multicastSocket;
    private ServerSocket serverSocket;
    private WifiManager.MulticastLock multicastLock;
    private volatile int httpPort;
    private volatile String localAddress;

    VtDial(MainActivity activity, String uuid) {
        this.activity = activity;
        this.uuid = uuid;
    }

    public synchronized void start() {
        if (running) return;
        running = true;
        try {
            startHttp();
            startSsdp();
            Log.i(TAG, "DIAL started at http://" + localAddress + ":" + httpPort + "/");
        } catch (Exception err) {
            Log.w(TAG, "DIAL could not start", err);
            stop();
        }
    }

    public synchronized void stop() {
        running = false;
        try {
            if (multicastSocket != null) multicastSocket.close();
        } catch (Exception ignored) {
        }
        try {
            if (serverSocket != null) serverSocket.close();
        } catch (Exception ignored) {
        }
        if (multicastLock != null && multicastLock.isHeld()) {
            try {
                multicastLock.release();
            } catch (Exception ignored) {
            }
        }
        multicastSocket = null;
        serverSocket = null;
        Log.i(TAG, "DIAL stopped");
    }

    // ------------------------------------------------------------------ HTTP side

    private void startHttp() throws Exception {
        localAddress = findLocalAddress();
        serverSocket = new ServerSocket(0);
        httpPort = serverSocket.getLocalPort();

        httpThread = new Thread(() -> {
            while (running) {
                try {
                    Socket socket = serverSocket.accept();
                    new Thread(() -> handleConnection(socket), "vt-dial-http").start();
                } catch (Exception err) {
                    if (running) Log.w(TAG, "accept failed", err);
                }
            }
        }, "vt-dial-accept");
        httpThread.setDaemon(true);
        httpThread.start();
    }

    private void handleConnection(Socket socket) {
        try (Socket connection = socket) {
            connection.setSoTimeout(5000);
            BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream(), StandardCharsets.ISO_8859_1));

            String requestLine = reader.readLine();
            if (requestLine == null) return;
            String[] parts = requestLine.split(" ");
            if (parts.length < 2) return;
            String method = parts[0].toUpperCase(Locale.US);
            String target = parts[1];

            int contentLength = 0;
            String header;
            while ((header = reader.readLine()) != null && !header.isEmpty()) {
                int colon = header.indexOf(':');
                if (colon > 0 && "content-length".equalsIgnoreCase(header.substring(0, colon).trim())) {
                    try {
                        contentLength = Integer.parseInt(header.substring(colon + 1).trim());
                    } catch (NumberFormatException ignored) {
                    }
                }
            }

            String body = "";
            if (contentLength > 0 && contentLength <= 102400) {
                char[] buffer = new char[contentLength];
                int read = 0;
                while (read < contentLength) {
                    int count = reader.read(buffer, read, contentLength - read);
                    if (count < 0) break;
                    read += count;
                }
                body = new String(buffer, 0, read);
            }

            OutputStream raw = connection.getOutputStream();
            String baseUrl = "http://" + localAddress + ":" + httpPort;

            if (target.equals("/")) {
                writeResponse(raw, 200, "OK", "text/xml; charset=\"utf-8\"",
                        Collections.singletonList("Application-URL: " + baseUrl + "/apps"), deviceDescription(baseUrl));
                return;
            }

            if (target.startsWith("/apps")) {
                String rest = target.substring("/apps".length());
                int slash = rest.indexOf('/');
                String appName = slash == -1 ? rest : rest.substring(0, slash);
                String appPath = slash == -1 ? "" : rest.substring(slash);
                appName = appName.replace("/", "");
                if (appName.isEmpty()) {
                    writeResponse(raw, 200, "OK", "text/plain; charset=\"utf-8\"", null, "VacuumTube DIAL");
                    return;
                }
                String result = activity.dispatchDial(appName, method, appPath, body, baseUrl);
                if (result == null) {
                    writeResponse(raw, 503, "Service Unavailable", "text/plain; charset=\"utf-8\"", null, "no response from the page");
                    return;
                }
                JSONObject json = new JSONObject(result);
                int code = json.optInt("responseCode", 200);
                String responseBody = json.optString("body", "");
                String mime = json.optString("mimeType", "text/plain; charset=\"utf-8\"");
                writeResponse(raw, code, code == 200 ? "OK" : "DIAL", mime, null, responseBody);
                return;
            }

            writeResponse(raw, 404, "Not Found", "text/plain; charset=\"utf-8\"", null, "not found");
        } catch (Exception err) {
            Log.d(TAG, "connection failed: " + err);
        }
    }

    private String deviceDescription(String baseUrl) {
        // Mirrors dial/server.js:26-53 (same elements, built natively instead of with DOMParser).
        return "<?xml version=\"1.0\"?>"
                + "<root xmlns=\"urn:schemas-upnp-org:device-1-0\">"
                + "<specVersion><major>1</major><minor>0</minor></specVersion>"
                + "<URLBase>" + baseUrl + "</URLBase>"
                + "<device>"
                + "<deviceType>urn:dial-multiscreen-org:device:dial:1</deviceType>"
                + "<friendlyName>" + escapeXml(activity.bridgeDeviceName()) + " (VacuumTube)</friendlyName>"
                + "<manufacturer>VacuumTube</manufacturer>"
                + "<modelName>" + escapeXml(activity.versionName()) + "</modelName>"
                + "<UDN>uuid:" + uuid + "</UDN>"
                + "</device>"
                + "</root>";
    }

    private static String escapeXml(String value) {
        if (value == null) return "";
        return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;");
    }

    private static void writeResponse(OutputStream out, int code, String reason, String contentType,
                                      java.util.List<String> extraHeaders, String body) throws Exception {
        byte[] payload = (body == null ? "" : body).getBytes(StandardCharsets.UTF_8);
        StringBuilder head = new StringBuilder();
        head.append("HTTP/1.1 ").append(code).append(' ').append(reason).append("\r\n");
        if (contentType != null) head.append("Content-Type: ").append(contentType).append("\r\n");
        head.append("Content-Length: ").append(payload.length).append("\r\n");
        head.append("Connection: close\r\n");
        if (extraHeaders != null) {
            for (String header : extraHeaders) head.append(header).append("\r\n");
        }
        head.append("\r\n");
        out.write(head.toString().getBytes(StandardCharsets.ISO_8859_1));
        out.write(payload);
        out.flush();
    }

    // ------------------------------------------------------------------ SSDP side

    private void startSsdp() throws Exception {
        Context context = activity.getApplicationContext();
        try {
            WifiManager wifi = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
            if (wifi != null) {
                multicastLock = wifi.createMulticastLock("vacuumtube-dial");
                multicastLock.setReferenceCounted(true);
                multicastLock.acquire();
            }
        } catch (Exception err) {
            Log.w(TAG, "could not acquire the multicast lock", err);
        }

        multicastSocket = new MulticastSocket(SSDP_PORT);
        multicastSocket.setReuseAddress(true);
        multicastSocket.setTimeToLive(4);
        final InetAddress group = InetAddress.getByName(SSDP_ADDRESS);
        boolean joined = false;
        Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
        while (interfaces != null && interfaces.hasMoreElements()) {
            NetworkInterface networkInterface = interfaces.nextElement();
            try {
                if (!networkInterface.isUp() || networkInterface.isLoopback()) continue;
                multicastSocket.joinGroup(new InetSocketAddress(group, SSDP_PORT), networkInterface);
                joined = true;
            } catch (Exception ignored) {
            }
        }
        if (!joined) {
            try {
                multicastSocket.joinGroup(group);
            } catch (Exception err) {
                Log.w(TAG, "could not join the SSDP group", err);
            }
        }

        ssdpThread = new Thread(() -> {
            byte[] buffer = new byte[4096];
            while (running) {
                try {
                    DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
                    multicastSocket.receive(packet);
                    String message = new String(packet.getData(), 0, packet.getLength(), StandardCharsets.UTF_8);
                    if (!message.toUpperCase(Locale.US).startsWith("M-SEARCH")) continue;
                    String upper = message.toUpperCase(Locale.US);
                    boolean interested = upper.contains(DIAL_ST.toUpperCase(Locale.US)) || upper.contains("SSDP:ALL");
                    if (!interested) continue;

                    String baseUrl = "http://" + localAddress + ":" + httpPort;
                    String response = "HTTP/1.1 200 OK\r\n"
                            + "CACHE-CONTROL: max-age=1800\r\n"
                            + "EXT:\r\n"
                            + "LOCATION: " + baseUrl + "/\r\n"
                            + "SERVER: Android/" + android.os.Build.VERSION.RELEASE + " VacuumTube/" + activity.versionName() + "\r\n"
                            + "ST: " + DIAL_ST + "\r\n"
                            + "USN: uuid:" + uuid + "::" + DIAL_ST + "\r\n"
                            + "WAKEUP: MAC=000000000000;Timeout=10\r\n"
                            + "\r\n";
                    byte[] payload = response.getBytes(StandardCharsets.UTF_8);
                    multicastSocket.send(new DatagramPacket(payload, payload.length, packet.getAddress(), packet.getPort()));
                    Log.i(TAG, "answered M-SEARCH from " + packet.getAddress().getHostAddress());
                } catch (Exception err) {
                    if (running) Log.d(TAG, "SSDP receive failed: " + err);
                }
            }
        }, "vt-dial-ssdp");
        ssdpThread.setDaemon(true);
        ssdpThread.start();
    }

    private static String findLocalAddress() {
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            while (interfaces != null && interfaces.hasMoreElements()) {
                NetworkInterface networkInterface = interfaces.nextElement();
                if (!networkInterface.isUp() || networkInterface.isLoopback()) continue;
                Enumeration<InetAddress> addresses = networkInterface.getInetAddresses();
                while (addresses.hasMoreElements()) {
                    InetAddress address = addresses.nextElement();
                    if (address.isSiteLocalAddress() && address.getHostAddress() != null && address.getHostAddress().indexOf(':') < 0) {
                        return address.getHostAddress();
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return "127.0.0.1";
    }
}
