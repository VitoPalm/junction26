package com.junction26.applets;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.media.*;
import android.os.*;
import android.speech.*;
import com.getcapacitor.JSObject;
import java.io.*;
import java.net.*;
import java.util.*;
import java.util.concurrent.*;
import org.json.*;

/**
 * Owns audio and transport independently of the Capacitor web view. Never auto-starts after boot.
 */
public class NoteRecorderService extends Service {
  static volatile NoteRecorderService instance;
  static volatile String mode = "auto";
  private volatile boolean enabled, connected, capturing;
  private volatile String phase = "off", detector;
  private String server, token, message, micLabel;
  private File directory, pcmFile;
  private JSONObject note, lastSaved;
  private long expires, started;
  private AudioRecord audio;
  private FileOutputStream pcm;
  private SpeechRecognizer recognizer;
  private ParcelFileDescriptor[] speechPipe;
  private OutputStream speechWriter;
  private final ThreadPoolExecutor speechFeed =
      new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(6));
  private final ScheduledExecutorService network = Executors.newSingleThreadScheduledExecutor();
  private final Handler main = new Handler(Looper.getMainLooper());
  private HttpURLConnection events;
  private AudioManager manager;
  private AudioFocusRequest focus;
  private PowerManager.WakeLock wake;
  private int previousAudioMode;
  private boolean routeOwned;
  private long lastHeard, lastCheck;
  private boolean liveBusy;
  private final Object lock = new Object();
  private Thread audioThread;

  static JSObject state() {
    NoteRecorderService s = instance;
    if (s == null) {
      JSObject out = new JSObject();
      out.put("phase", "off");
      out.put("connected", false);
      out.put("liveMode", mode);
      out.put("pending", 0);
      return out;
    }
    synchronized (s.lock) {
      JSObject out = new JSObject();
      out.put("phase", s.phase);
      out.put("connected", s.connected);
      out.put("liveMode", mode);
      out.put("detector", s.detector == null ? JSONObject.NULL : s.detector);
      out.put("note", s.note == null ? JSONObject.NULL : s.note);
      out.put("message", s.message == null ? JSONObject.NULL : s.message);
      out.put("micLabel", s.micLabel == null ? JSONObject.NULL : s.micLabel);
      out.put("lastSaved", s.lastSaved == null ? JSONObject.NULL : s.lastSaved);
      File[] files =
          s.directory == null ? null : s.directory.listFiles((d, n) -> n.endsWith(".json"));
      out.put("pending", files == null ? 0 : files.length);
      return out;
    }
  }

  private void publish() {
    main.post(
        () -> {
          if (NoteRecorderPlugin.active != null) NoteRecorderPlugin.active.publish(state());
        });
  }

  @Override
  public android.os.IBinder onBind(Intent i) {
    return null;
  }

  @Override
  public void onCreate() {
    super.onCreate();
    instance = this;
  }

  @Override
  public int onStartCommand(Intent i, int flags, int id) {
    if (i == null || "stop".equals(i.getAction())) {
      shutdown();
      return START_NOT_STICKY;
    }
    if (enabled) return START_NOT_STICKY;
    server = i.getStringExtra("server");
    token = i.getStringExtra("token");
    mode = i.getStringExtra("liveMode");
    try {
      expires =
          new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSX", java.util.Locale.US)
              .parse(i.getStringExtra("expiresAt"))
              .getTime();
    } catch (Exception e) {
      stopSelf();
      return START_NOT_STICKY;
    }
    String owner = i.getStringExtra("ownerId");
    if (owner == null || !owner.matches("[0-9a-f-]{36}")) {
      stopSelf();
      return START_NOT_STICKY;
    }
    directory =
        new File(
            getNoBackupFilesDir(),
            "notes/"
                + java.util
                    .UUID
                    .nameUUIDFromBytes(server.getBytes(java.nio.charset.StandardCharsets.UTF_8))
                    .toString()
                + "/"
                + owner);
    directory.mkdirs();
    NotificationManager nm = getSystemService(NotificationManager.class);
    if (Build.VERSION.SDK_INT >= 26)
      nm.createNotificationChannel(
          new NotificationChannel("notes", "Voice notes", NotificationManager.IMPORTANCE_LOW));
    Intent stop = new Intent(this, NoteRecorderService.class).setAction("stop");
    PendingIntent stopIntent =
        PendingIntent.getService(this, 2, stop, PendingIntent.FLAG_IMMUTABLE);
    PendingIntent open =
        PendingIntent.getActivity(
            this, 3, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
    Notification.Builder nb =
        Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(this, "notes")
            : new Notification.Builder(this);
    Notification n =
        nb.setContentTitle("Applet voice notes")
            .setContentText("Recorder enabled. Tap Stop to turn it off.")
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(new Notification.Action.Builder(null, "Stop", stopIntent).build())
            .build();
    if (Build.VERSION.SDK_INT >= 30)
      startForeground(26, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
    else startForeground(26, n);
    manager = getSystemService(AudioManager.class);
    wake =
        ((PowerManager) getSystemService(POWER_SERVICE))
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "applets:notes");
    wake.acquire(Math.max(1, Math.min(expires - System.currentTimeMillis(), 12 * 60 * 60 * 1000)));
    enabled = true;
    phase = "ready";
    publish();
    network.execute(this::recover);
    network.scheduleWithFixedDelay(this::flushNow, 0, 15, TimeUnit.SECONDS);
    new Thread(this::listen, "note-events").start();
    main.postDelayed(this::tick, 1000);
    return START_NOT_STICKY;
  }

  private void tick() {
    if (!enabled) return;
    if (System.currentTimeMillis() >= expires) {
      message = "Recorder session ended. Reopen the app and turn it on again.";
      shutdown();
      return;
    }
    if (note != null) {
      if (System.currentTimeMillis() - started >= note.optInt("maxSeconds", 300) * 1000L)
        finish("timeout", -1);
      else if (!"off".equals(detector)) {
        if ("device".equals(detector) && System.currentTimeMillis() - lastHeard > 6000) fallback();
        if ("cloud".equals(detector)) checkCloud();
      }
    }
    main.postDelayed(this::tick, 1000);
  }

  private HttpURLConnection connection(String path, String method) throws Exception {
    HttpURLConnection c = (HttpURLConnection) new URL(server + path).openConnection();
    c.setInstanceFollowRedirects(false);
    c.setRequestMethod(method);
    c.setConnectTimeout(10000);
    c.setReadTimeout(35000);
    c.setRequestProperty("Authorization", "Bearer " + token);
    return c;
  }

  private JSONObject request(String path, String method, byte[] bytes, String type)
      throws Exception {
    HttpURLConnection c = connection(path, method);
    try {
      if (bytes != null) {
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", type);
        c.setFixedLengthStreamingMode(bytes.length);
        try (OutputStream o = c.getOutputStream()) {
          o.write(bytes);
        }
      }
      int status = c.getResponseCode();
      if (status < 200 || status >= 300) throw new IOException("HTTP " + status);
      try (InputStream in = c.getInputStream()) {
        return new JSONObject(
            new String(NoteAudio.read(in), java.nio.charset.StandardCharsets.UTF_8));
      }
    } finally {
      c.disconnect();
    }
  }

  private void listen() {
    while (enabled) {
      try {
        HttpURLConnection c = events = connection("/v1/notes/recorder/events", "GET");
        if (c.getResponseCode() != 200) throw new IOException("Recorder authentication failed");
        connected = true;
        publish();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream()))) {
          String line, event = "", data = "";
          while (enabled && (line = r.readLine()) != null) {
            if (line.startsWith("event: ")) event = line.substring(7);
            else if (line.startsWith("data: ")) data = line.substring(6);
            else if (line.isEmpty() && !data.isEmpty()) {
              JSONObject d = new JSONObject(data);
              String kind = event;
              main.post(
                  () -> {
                    try {
                      if (kind.equals("start")) begin(d.getJSONObject("note"));
                      else if (kind.equals("stop")
                          && note != null
                          && note.optString("id").equals(d.optString("noteId")))
                        finish(d.optString("reason", "band"), -1);
                    } catch (Exception ignored) {
                    }
                  });
              data = "";
              event = "";
            }
          }
        } finally {
          c.disconnect();
        }
      } catch (Exception ignored) {
      } finally {
        connected = false;
        publish();
      }
      if (enabled)
        try {
          Thread.sleep(1500);
        } catch (InterruptedException ignored) {
        }
    }
  }

  private void begin(JSONObject incoming) {
    if (!enabled || note != null) return;
    try {
      String id = incoming.getString("id");
      if (!id.matches("[0-9a-f-]{36}") || new File(directory, id + ".wav").exists()) return;
      previousAudioMode = manager.getMode();
      routeOwned = true;
      manager.setMode(AudioManager.MODE_IN_COMMUNICATION);
      if (Build.VERSION.SDK_INT >= 31
          && checkSelfPermission(android.Manifest.permission.BLUETOOTH_CONNECT)
              == android.content.pm.PackageManager.PERMISSION_GRANTED) {
        for (AudioDeviceInfo d : manager.getAvailableCommunicationDevices())
          if (d.getType() == AudioDeviceInfo.TYPE_BLUETOOTH_SCO) {
            manager.setCommunicationDevice(d);
            break;
          }
      } else if (Build.VERSION.SDK_INT < 31) {
        manager.startBluetoothSco();
        manager.setBluetoothScoOn(true);
      }
      AudioAttributes attrs =
          new AudioAttributes.Builder()
              .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
              .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
              .build();
      if (Build.VERSION.SDK_INT >= 26) {
        focus =
            new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(attrs)
                .setOnAudioFocusChangeListener(
                    change -> {
                      if (change < 0) main.post(() -> finish("interrupted", -1));
                    })
                .build();
        if (manager.requestAudioFocus(focus) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED)
          throw new IOException("Audio busy");
      }
      int size =
          Math.max(
              6400,
              AudioRecord.getMinBufferSize(
                  16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT));
      audio =
          new AudioRecord(
              MediaRecorder.AudioSource.VOICE_COMMUNICATION,
              16000,
              AudioFormat.CHANNEL_IN_MONO,
              AudioFormat.ENCODING_PCM_16BIT,
              size);
      if (audio.getState() != AudioRecord.STATE_INITIALIZED)
        throw new IOException("Microphone unavailable");
      started = System.currentTimeMillis();
      note = new JSONObject(incoming.toString());
      note.put("startedAt", started);
      pcmFile = new File(directory, id + ".pcm");
      pcm = new FileOutputStream(pcmFile);
      JSONObject meta = new JSONObject(note.toString()).put("endReason", "interrupted");
      writeJson(new File(directory, id + ".json"), meta);
      audio.startRecording();
      capturing = true;
      phase = "recording";
      AudioDeviceInfo route = audio.getRoutedDevice();
      micLabel =
          route == null
              ? "Phone audio input (Bluetooth route unverified)"
              : route.getProductName().toString();
      detector = mode.equals("off") ? "off" : mode.equals("cloud") ? "cloud" : "device";
      if (detector.equals("device")) startRecognition();
      AudioRecord source = audio;
      audioThread =
          new Thread(
              () -> {
                byte[] b = new byte[3200];
                while (capturing) {
                  int n = source.read(b, 0, b.length);
                  if (n < 0) {
                    main.post(() -> finish("interrupted", -1));
                    break;
                  }
                  if (n == 0) continue;
                  synchronized (lock) {
                    if (pcm != null)
                      try {
                        pcm.write(b, 0, n);
                      } catch (IOException e) {
                        main.post(() -> shutdown());
                      }
                  }
                  OutputStream writer = speechWriter;
                  if (writer != null) {
                    byte[] copy = Arrays.copyOf(b, n);
                    if (speechFeed.getQueue().remainingCapacity() == 0) {
                      main.post(this::fallback);
                    } else
                      speechFeed.execute(
                          () -> {
                            try {
                              writer.write(copy);
                              writer.flush();
                            } catch (IOException ignored) {
                            }
                          });
                  }
                }
              },
              "note-audio");
      audioThread.start();
      lastHeard = System.currentTimeMillis();
      publish();
      network.execute(
          () -> {
            try {
              request("/v1/notes/" + id + "/recording", "POST", null, null);
            } catch (Exception ignored) {
            }
          });
    } catch (Exception e) {
      message = "Microphone unavailable. Check permissions and audio route.";
      finish("interrupted", -1);
      releaseAudio();
      publish();
    }
  }

  private void startRecognition() {
    if (Build.VERSION.SDK_INT < 33 || !SpeechRecognizer.isOnDeviceRecognitionAvailable(this)) {
      fallback();
      return;
    }
    try {
      recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(this);
      SpeechRecognizer current = recognizer;
      speechPipe = ParcelFileDescriptor.createPipe();
      speechWriter = new ParcelFileDescriptor.AutoCloseOutputStream(speechPipe[1]);
      recognizer.setRecognitionListener(
          new RecognitionListener() {
            public void onReadyForSpeech(Bundle b) {}

            public void onBeginningOfSpeech() {}

            public void onRmsChanged(float r) {}

            public void onBufferReceived(byte[] b) {}

            public void onEndOfSpeech() {}

            public void onError(int e) {
              if (recognizer == current) fallback();
            }

            public void onResults(Bundle b) {
              if (recognizer != current) return;
              heard(b);
              if (note != null && "device".equals(detector)) {
                stopRecognition();
                startRecognition();
              }
            }

            public void onPartialResults(Bundle b) {
              if (recognizer == current) heard(b);
            }

            public void onEvent(int t, Bundle b) {}
          });
      Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
      i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
      i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "en-US");
      i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
      i.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, speechPipe[0]);
      i.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1);
      i.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, 16000);
      i.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT);
      recognizer.startListening(i);
    } catch (Exception e) {
      fallback();
    }
  }

  private void heard(Bundle b) {
    ArrayList<String> texts = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
    if (texts == null || texts.isEmpty()) return;
    lastHeard = System.currentTimeMillis();
    if (NoteAudio.stopPhrase(texts.get(0))) finish("phrase", -1);
  }

  private void stopRecognition() {
    SpeechRecognizer r = recognizer;
    recognizer = null;
    if (r != null) {
      r.cancel();
      r.destroy();
    }
    OutputStream writer = speechWriter;
    speechWriter = null;
    try {
      if (writer != null) writer.close();
      if (speechPipe != null) speechPipe[0].close();
    } catch (IOException ignored) {
    }
    speechPipe = null;
  }

  private void fallback() {
    if (note == null) return;
    detector = "cloud";
    stopRecognition();
    publish();
  }

  private byte[] tail() throws IOException {
    synchronized (lock) {
      if (pcmFile == null) return new byte[0];
      try (RandomAccessFile r = new RandomAccessFile(pcmFile, "r")) {
        int n = (int) Math.min(160000, r.length());
        byte[] b = new byte[n];
        r.seek(r.length() - n);
        r.readFully(b);
        return b;
      }
    }
  }

  private void checkCloud() {
    if (liveBusy || System.currentTimeMillis() - lastCheck < 2000) return;
    try {
      byte[] b = tail();
      if (b.length < 48000
          || NoteAudio.rms(b, b.length - 9600, b.length) > .01
          || !NoteAudio.speech(b)) return;
      String id = note.getString("id");
      long windowStart = Math.max(0, pcmFile.length() - b.length);
      liveBusy = true;
      lastCheck = System.currentTimeMillis();
      network.execute(
          () -> {
            try {
              JSONObject r =
                  request("/v1/notes/" + id + "/live", "POST", NoteAudio.wav(b), "audio/wav");
              if (r.optBoolean("stop"))
                main.post(
                    () -> {
                      if (note != null && note.optString("id").equals(id))
                        finish(
                            "phrase",
                            r.isNull("startSeconds")
                                ? -1
                                : (int)
                                    Math.max(
                                        0,
                                        windowStart + (r.optDouble("startSeconds") - .15) * 32000));
                    });
            } catch (Exception ignored) {
            } finally {
              liveBusy = false;
            }
          });
    } catch (Exception ignored) {
    }
  }

  private void finish(String reason, int cut) {
    if (note == null) return;
    phase = "saving";
    captureStop();
    stopRecognition();
    JSONObject current = note;
    note = null;
    detector = null;
    try {
      String id = current.getString("id");
      byte[] b = NoteAudio.read(pcmFile);
      if (reason.equals("phrase")) b = NoteAudio.trim(b, cut);
      if (NoteAudio.speech(b)) {
        NoteAudio.write(new File(directory, id + ".wav"), NoteAudio.wav(b));
        current.put("durationMs", b.length / 32).put("endReason", reason);
        writeJson(new File(directory, id + ".json"), current);
      } else {
        new File(directory, id + ".json").delete();
        network.execute(
            () -> {
              try {
                request(
                    "/v1/notes/" + id + "/discard",
                    "POST",
                    "{\"reason\":\"too_short\"}".getBytes(),
                    "application/json");
              } catch (Exception ignored) {
              }
            });
        message = "Too short, nothing saved.";
      }
      pcmFile.delete();
      pcmFile = null;
    } catch (Exception e) {
      message = "Recording kept on this phone; reopen to recover it.";
    }
    releaseAudio();
    phase = enabled ? "ready" : "off";
    publish();
    flushQueue();
  }

  private void captureStop() {
    capturing = false;
    try {
      if (audio != null) audio.stop();
    } catch (Exception ignored) {
    }
    try {
      if (audioThread != null) audioThread.join(2000);
    } catch (InterruptedException ignored) {
    }
    synchronized (lock) {
      try {
        if (pcm != null) {
          pcm.getFD().sync();
          pcm.close();
        }
      } catch (IOException ignored) {
      }
      pcm = null;
    }
  }

  private void releaseAudio() {
    if (audio != null) {
      audio.release();
      audio = null;
    }
    if (manager != null && routeOwned) {
      routeOwned = false;
      if (Build.VERSION.SDK_INT >= 31) manager.clearCommunicationDevice();
      else {
        manager.setBluetoothScoOn(false);
        manager.stopBluetoothSco();
      }
      if (focus != null && Build.VERSION.SDK_INT >= 26) manager.abandonAudioFocusRequest(focus);
      manager.setMode(previousAudioMode);
    }
  }

  private static void writeJson(File target, JSONObject value) throws Exception {
    NoteAudio.write(target, value.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
  }

  private void recover() {
    File[] files = directory.listFiles((d, n) -> n.endsWith(".pcm"));
    if (files == null) return;
    for (File f : files)
      try {
        String id = f.getName().replace(".pcm", "");
        File meta = new File(directory, id + ".json");
        if (!meta.exists()) continue;
        byte[] b = NoteAudio.read(f);
        JSONObject m =
            new JSONObject(
                new String(NoteAudio.read(meta), java.nio.charset.StandardCharsets.UTF_8));
        m.put("durationMs", b.length / 32).put("endReason", "interrupted");
        NoteAudio.write(new File(directory, id + ".wav"), NoteAudio.wav(b));
        writeJson(meta, m);
        f.delete();
      } catch (Exception ignored) {
      }
  }

  void flushQueue() {
    if (!network.isShutdown()) network.execute(this::flushNow);
  }

  private void flushNow() {
    if (directory == null || token == null || System.currentTimeMillis() >= expires) return;
    File[] files = directory.listFiles((d, n) -> n.endsWith(".json"));
    if (files == null) return;
    for (File f : files)
      try {
        JSONObject m =
            new JSONObject(new String(NoteAudio.read(f), java.nio.charset.StandardCharsets.UTF_8));
        String id = m.getString("id");
        File wav = new File(directory, id + ".wav");
        if (!wav.exists()) continue;
        byte[] bytes = NoteAudio.read(wav);
        JSONObject result =
            request(
                "/v1/notes/"
                    + id
                    + "/audio?durationMs="
                    + m.optInt("durationMs")
                    + "&endReason="
                    + m.optString("endReason", "interrupted"),
                "PUT",
                bytes,
                "audio/wav");
        byte[] digest = java.security.MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder hash = new StringBuilder();
        for (byte b : digest) hash.append(String.format("%02x", b & 255));
        if (!hash.toString()
            .equals(result.getJSONObject("note").getJSONObject("audio").optString("sha256")))
          throw new IOException("Audio confirmation mismatch");
        wav.delete();
        f.delete();
        lastSaved =
            new JSONObject()
                .put("pageLabel", m.optString("pageLabel"))
                .put("at", System.currentTimeMillis());
        message = null;
        publish();
      } catch (Exception e) {
        message = "Saved on this phone; uploading when online…";
        publish();
        break;
      }
  }

  void shutdown() {
    enabled = false;
    finish("interrupted", -1);
    stopRecognition();
    captureStop();
    releaseAudio();
    if (events != null) events.disconnect();
    connected = false;
    phase = "off";
    publish();
    if (wake != null && wake.isHeld()) wake.release();
    stopForeground(STOP_FOREGROUND_REMOVE);
    stopSelf();
  }

  @Override
  public void onDestroy() {
    shutdown();
    network.shutdown();
    speechFeed.shutdownNow();
    instance = null;
    super.onDestroy();
  }
}
