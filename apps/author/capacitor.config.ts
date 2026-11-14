import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Native shells load the bundled app (webDir) and call the API on its own
 * HTTPS origin, allowed by the API's CORS_ORIGINS (capacitor://localhost on
 * iOS, https://localhost on Android).
 *
 * CAP_DEV=1 (local development only) allows plain-HTTP API calls, e.g. to
 * http://localhost:8080 forwarded into the emulator with `adb reverse`.
 * Never ship a build made with it.
 */
const dev = process.env.CAP_DEV === '1';

const config: CapacitorConfig = {
  appId: 'com.junction26.applets',
  appName: 'Applets',
  webDir: 'dist',
  server: { androidScheme: 'https', ...(dev ? { cleartext: true } : {}) },
  android: { allowMixedContent: dev },
  plugins: {
    // Dark UI: light status/navigation bar icons on both platforms.
    SystemBars: { style: 'DARK' },
  },
};

export default config;
