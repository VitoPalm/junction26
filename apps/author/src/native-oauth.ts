import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import type { useClerk } from '@clerk/react';

/**
 * Social sign-in for the Capacitor shells.
 *
 * Clerk's web buttons navigate the WebView to the provider, which Google refuses
 * (embedded WebView) and which Capacitor hands to Chrome anyway, so the redirect back
 * never reaches the app. Instead, the same flow Clerk's native SDKs use:
 *
 * 1. Create the sign-in with a redirect URL on our own scheme.
 * 2. Open the provider URL in the system browser (Custom Tab / SFSafariViewController).
 * 3. Clerk redirects to com.junction26.applets://oauth-callback?rotating_token_nonce=…,
 *    the OS reopens the app, and reloading the sign-in with that nonce completes it
 *    on this WebView's Clerk client.
 * 4. New users come back "transferable" and are turned into a sign-up.
 *
 * The redirect URL must be allowed in the Clerk instance (Native applications →
 * allowlist for mobile SSO redirect).
 */
export const NATIVE_OAUTH_REDIRECT = 'com.junction26.applets://oauth-callback';

export type NativeOAuthProvider = 'google' | 'apple' | 'facebook';

type Clerk = ReturnType<typeof useClerk>;

/** Resolves with the callback URL, or rejects if the user closes the browser first. */
function waitForCallback(): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const handles: Array<Promise<{ remove: () => Promise<void> }>> = [];
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      for (const h of handles) void h.then((x) => x.remove());
      fn();
    };
    handles.push(App.addListener('appUrlOpen', ({ url }) => {
      if (url.startsWith(NATIVE_OAUTH_REDIRECT)) done(() => resolve(url));
    }));
    // iOS: the user dismissed the Safari sheet. Android doesn't report this; there the
    // promise stays pending until the next attempt replaces it, which is harmless.
    handles.push(Browser.addListener('browserFinished', () => {
      setTimeout(() => done(() => reject(new Error('Sign-in was cancelled.'))), 500);
    }));
  });
}

export async function signInWithProvider(clerk: Clerk, provider: NativeOAuthProvider): Promise<void> {
  const client = clerk.client;
  if (!client) throw new Error('Sign-in is still loading.');
  const signIn = await client.signIn.create({ strategy: `oauth_${provider}`, redirectUrl: NATIVE_OAUTH_REDIRECT });
  const url = signIn.firstFactorVerification.externalVerificationRedirectURL;
  if (!url) throw new Error('Clerk did not return a provider URL.');

  const callback = waitForCallback();
  await Browser.open({ url: url.toString(), presentationStyle: 'popover' });
  const returned = new URL(await callback);
  void Browser.close().catch(() => undefined); // iOS; Android's Custom Tab is already gone.

  const error = returned.searchParams.get('error_description') ?? returned.searchParams.get('error');
  if (error) throw new Error(error);
  const rotatingTokenNonce = returned.searchParams.get('rotating_token_nonce') ?? '';
  await signIn.reload({ rotatingTokenNonce });

  let session = signIn.status === 'complete' ? signIn.createdSessionId : null;
  if (!session && signIn.firstFactorVerification.status === 'transferable') {
    const signUp = await client.signUp.create({ transfer: true });
    session = signUp.createdSessionId;
    if (!session) throw new Error(`Sign-up needs more information (${signUp.missingFields.join(', ') || signUp.status}).`);
  }
  if (!session) throw new Error(`Sign-in did not complete (${signIn.status ?? 'unknown status'}).`);
  await clerk.setActive({ session });
}
