package com.junction26.applets;

import android.Manifest;
import android.content.Intent;
import com.getcapacitor.*;
import com.getcapacitor.annotation.*;

@CapacitorPlugin(
    name = "NoteRecorder",
    permissions = {
      @Permission(
          alias = "mic",
          strings = {Manifest.permission.RECORD_AUDIO}),
      @Permission(
          alias = "bluetooth",
          strings = {Manifest.permission.BLUETOOTH_CONNECT})
    })
public class NoteRecorderPlugin extends Plugin {
  static NoteRecorderPlugin active;

  @Override
  public void load() {
    active = this;
  }

  void publish(JSObject state) {
    notifyListeners("state", state);
  }

  @PluginMethod
  public void start(PluginCall call) {
    if (getPermissionState("mic") != PermissionState.GRANTED) {
      requestPermissionForAlias("mic", call, "micResult");
      return;
    }
    if (android.os.Build.VERSION.SDK_INT >= 31
        && getPermissionState("bluetooth") != PermissionState.GRANTED) {
      requestPermissionForAlias("bluetooth", call, "bluetoothResult");
      return;
    }
    launch(call);
  }

  @PermissionCallback
  private void micResult(PluginCall call) {
    if (getPermissionState("mic") != PermissionState.GRANTED) {
      call.reject("Allow microphone access to record notes");
      return;
    }
    start(call);
  }

  @PermissionCallback
  private void bluetoothResult(PluginCall call) {
    launch(call);
  }

  private void launch(PluginCall call) {
    String server = call.getString("server", "");
    if (!server.startsWith("https://")
        && !server.startsWith("http://localhost")
        && !server.startsWith("http://10.0.2.2")) {
      call.reject("Use an HTTPS API server");
      return;
    }
    Intent i = new Intent(getContext(), NoteRecorderService.class);
    i.putExtra("server", server);
    i.putExtra("token", call.getString("token"));
    i.putExtra("ownerId", call.getString("ownerId"));
    i.putExtra("expiresAt", call.getString("expiresAt"));
    i.putExtra("liveMode", call.getString("liveMode", "auto"));
    try {
      androidx.core.content.ContextCompat.startForegroundService(getContext(), i);
      call.resolve();
    } catch (Exception e) {
      call.reject("Open this app before enabling the recorder");
    }
  }

  @PluginMethod
  public void stop(PluginCall call) {
    NoteRecorderService s = NoteRecorderService.instance;
    if (s != null) s.shutdown();
    call.resolve();
  }

  @PluginMethod
  public void status(PluginCall call) {
    call.resolve(NoteRecorderService.state());
  }

  @PluginMethod
  public void setMode(PluginCall call) {
    NoteRecorderService.mode = call.getString("liveMode", "auto");
    call.resolve();
  }

  @PluginMethod
  public void flush(PluginCall call) {
    if (NoteRecorderService.instance != null) NoteRecorderService.instance.flushQueue();
    call.resolve();
  }

  @Override
  protected void handleOnDestroy() {
    if (active == this) active = null;
  }
}
