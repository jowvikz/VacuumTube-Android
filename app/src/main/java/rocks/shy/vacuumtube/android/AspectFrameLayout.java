package rocks.shy.vacuumtube.android;

import android.content.Context;
import android.util.AttributeSet;
import android.widget.FrameLayout;

/**
 * Keeps its child at a fixed aspect ratio, centred, with letterboxing — the Android equivalent of
 * the desktop app's 16:9 content lock (src/index.js:366-398: setAspectRatio / will-resize math).
 * The Leanback UI is a 16:9 TV surface, so on a 20:9 phone it gets black side bars instead of a
 * stretched or cropped layout.
 */
public class AspectFrameLayout extends FrameLayout {

    private float aspect = 16f / 9f;

    public AspectFrameLayout(Context context) {
        super(context);
    }

    public AspectFrameLayout(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    public void setAspect(float aspect) {
        if (aspect > 0) {
            this.aspect = aspect;
            requestLayout();
        }
    }

    private int[] fit(int width, int height) {
        int targetWidth = width;
        int targetHeight = Math.round(width / aspect);
        if (targetHeight > height) {
            targetHeight = height;
            targetWidth = Math.round(height * aspect);
        }
        return new int[]{targetWidth, targetHeight};
    }

    @Override
    protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
        int width = MeasureSpec.getSize(widthMeasureSpec);
        int height = MeasureSpec.getSize(heightMeasureSpec);
        setMeasuredDimension(width, height);

        int[] size = fit(width, height);
        for (int i = 0; i < getChildCount(); i++) {
            getChildAt(i).measure(MeasureSpec.makeMeasureSpec(size[0], MeasureSpec.EXACTLY),
                    MeasureSpec.makeMeasureSpec(size[1], MeasureSpec.EXACTLY));
        }
    }

    @Override
    protected void onLayout(boolean changed, int left, int top, int right, int bottom) {
        int width = right - left;
        int height = bottom - top;
        int[] size = fit(width, height);
        int offsetX = (width - size[0]) / 2;
        int offsetY = (height - size[1]) / 2;
        for (int i = 0; i < getChildCount(); i++) {
            getChildAt(i).layout(offsetX, offsetY, offsetX + size[0], offsetY + size[1]);
        }
    }
}
