package com.junction26.applets;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NoteRecorderPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
