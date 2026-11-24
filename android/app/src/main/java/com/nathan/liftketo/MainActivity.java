package com.nathan.liftketo;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(HydrationPlugin.class);
        registerPlugin(VitalsPlugin.class);
        registerPlugin(SamsungWaterPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
