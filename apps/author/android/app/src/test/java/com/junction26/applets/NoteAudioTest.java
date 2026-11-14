package com.junction26.applets;

import static org.junit.Assert.*;

import java.io.*;
import java.nio.*;
import java.util.*;
import org.junit.Test;

public class NoteAudioTest {
  private byte[] speech(int ms) {
    ByteBuffer b = ByteBuffer.allocate(ms * 32).order(ByteOrder.LITTLE_ENDIAN);
    for (int i = 0; i < ms * 16; i++) b.putShort((short) (Math.sin(i * .12) * 14000));
    return b.array();
  }

  @Test
  public void phraseMustEndTheUtterance() {
    assertTrue(NoteAudio.stopPhrase("I am done. Stop recording metta."));
    assertFalse(NoteAudio.stopPhrase("stop recording rows twice"));
    assertFalse(NoteAudio.stopPhrase("stop recording meta is the phrase"));
  }

  @Test
  public void wavHeaderDescribesTheActualSamples() {
    byte[] pcm = speech(2000), wav = NoteAudio.wav(pcm);
    ByteBuffer h = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN);
    assertEquals(16000, h.getInt(24));
    assertEquals(pcm.length, h.getInt(40));
    assertEquals(1, h.getShort(22));
    assertArrayEquals(pcm, Arrays.copyOfRange(wav, 44, wav.length));
  }

  @Test
  public void trimPreservesTheNoteAndRemovesSpokenCommandAfterPause() throws Exception {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    out.write(speech(2000));
    out.write(new byte[400 * 32]);
    out.write(speech(1600));
    out.write(new byte[300 * 32]);
    byte[] trimmed = NoteAudio.trim(out.toByteArray(), -1);
    assertTrue(trimmed.length >= 2000 * 32);
    assertTrue(trimmed.length <= 2400 * 32);
    assertTrue(NoteAudio.speech(trimmed));
    assertFalse(NoteAudio.speech(new byte[1000 * 32]));
    assertFalse(NoteAudio.speech(speech(200)));
  }

  @Test
  public void atomicFileCommitSurvivesReadback() throws Exception {
    File f = File.createTempFile("note", ".wav");
    try {
      byte[] bytes = NoteAudio.wav(speech(1000));
      NoteAudio.write(f, bytes);
      assertArrayEquals(bytes, NoteAudio.read(f));
    } finally {
      f.delete();
    }
  }
}
