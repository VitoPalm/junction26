package com.junction26.applets;

import java.io.*;
import java.nio.*;
import java.util.*;
import java.util.regex.Pattern;

/** PCM16 mono 16 kHz files. Pure helpers also exercised by JVM tests. */
final class NoteAudio {
    static byte[] read(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] buffer = new byte[8192]; int n;
        while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n); return out.toByteArray();
    }
    static byte[] read(File file) throws IOException { try (FileInputStream in = new FileInputStream(file)) { return read(in); } }
    static void write(File target, byte[] bytes) throws IOException {
        File temp = new File(target.getPath() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(temp)) { out.write(bytes); out.getFD().sync(); }
        if (!temp.renameTo(target)) throw new IOException("Could not commit recording");
    }
    static final int RATE = 16000;
    static final Pattern STOP = Pattern.compile("(?i)\\bstop(?:ped|ping)?\\s+(?:the\\s+)?recording[\\s,.]*(?:meta|metta|metal|medal|matter|better|media|mehta|met a|mesa|mena)[\\s.!?]*$");
    static boolean stopPhrase(String text) { return STOP.matcher(text.trim()).find(); }
    static byte[] wav(byte[] pcm) {
        ByteBuffer h = ByteBuffer.allocate(44 + pcm.length).order(ByteOrder.LITTLE_ENDIAN);
        h.put("RIFF".getBytes()).putInt(36 + pcm.length).put("WAVEfmt ".getBytes()).putInt(16);
        h.putShort((short)1).putShort((short)1).putInt(RATE).putInt(RATE*2).putShort((short)2).putShort((short)16);
        h.put("data".getBytes()).putInt(pcm.length).put(pcm); return h.array();
    }
    static double rms(byte[] pcm, int start, int end) {
        double sum = 0; int n = 0;
        for (int i = start; i + 1 < end; i += 2) { double v = (short)((pcm[i] & 255) | (pcm[i+1] << 8)) / 32768.0; sum += v*v; n++; }
        return n == 0 ? 0 : Math.sqrt(sum/n);
    }
    static byte[] trim(byte[] pcm, int exactCut) {
        if (exactCut >= 0) return Arrays.copyOf(pcm, Math.min(pcm.length, exactCut & ~1));
        int end = pcm.length / 640, min = Math.max(0, end - 175), f = end - 1, run = 0;
        while (f > min && rms(pcm, f*640, (f+1)*640) < .008) f--;
        for (; f > min; f--) {
            if (rms(pcm, f*640, (f+1)*640) < .008) { if (++run >= 10) return Arrays.copyOf(pcm, (f + run/2)*640); }
            else run = 0;
        }
        return Arrays.copyOf(pcm, Math.max(0, pcm.length - 51200));
    }
    static boolean speech(byte[] pcm) {
        int loud = 0; for (int i = 0; i + 640 <= pcm.length; i += 640) if (rms(pcm,i,i+640) > .012) loud++;
        return loud >= 30;
    }
}
