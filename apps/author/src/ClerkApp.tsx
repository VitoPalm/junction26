import { ClerkProvider, SignInButton, SignUpButton, useAuth, useClerk, useUser } from '@clerk/react';
import { useMemo, useState } from 'react';
import { App, Welcome } from './App.tsx';
import { BrandMark } from './icons.tsx';
import { createApi, defaultServer, isNative, type Session } from './api.ts';
import { signInWithProvider, type NativeOAuthProvider } from './native-oauth.ts';

export function ClerkApp() {
  const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;
  // VITE_CLERK_ALLOW_DEVELOPMENT=true is the hackathon opt-in for a pk_test_ key in a release build.
  const allowDevelopment = import.meta.env.VITE_CLERK_ALLOW_DEVELOPMENT === 'true';
  if (!publishableKey || (import.meta.env.PROD && !allowDevelopment && !publishableKey.startsWith('pk_live_'))) {
    return <Welcome><h2>Sign-in is not configured</h2><p className="muted">Set the Clerk publishable key for this build. Release builds require a production Clerk instance.</p></Welcome>;
  }
  // Native shells run Clerk's web sign-in inside the WebView (origin https://localhost on
  // Android, capacitor://localhost on iOS).
  const home = isNative ? `${window.location.origin}/` : `${window.location.origin}/author/`;
  return <ClerkProvider publishableKey={publishableKey}
    appearance={isNative ? { ...clerkAppearance, ...nativeAppearance } : clerkAppearance}
    signInFallbackRedirectUrl={home}
    signUpFallbackRedirectUrl={home}>
    <ClerkAccount />
  </ClerkProvider>;
}

// Clerk's own social buttons would navigate the WebView (Google refuses that, and the
// redirect lands in Chrome). Native hides them and uses NativeSocialButtons instead.
const clerkAppearance = { variables: { colorPrimary: '#1c1815', borderRadius: '14px', fontFamily: 'Figtree, system-ui, sans-serif' } };
const nativeAppearance = { elements: { socialButtonsRoot: { display: 'none' }, dividerRow: { display: 'none' } } };

function ClerkAccount() {
  const { isLoaded, isSignedIn, userId, getToken } = useAuth();
  const { user } = useUser();
  const { signOut } = useClerk();
  const account = useMemo(() => {
    if (!isSignedIn || !userId) return undefined;
    // No Clerk credentials are persisted by our application. The SDK owns session lifecycle.
    const session: Session = { server: defaultServer(), token: '', name: user?.fullName ?? user?.username ?? 'My account' };
    return { session, api: createApi(session, getToken), signOut: () => { void signOut(); } };
  }, [isSignedIn, userId, user?.fullName, user?.username, getToken, signOut]);
  if (!isLoaded) return <main className="loading-screen"><BrandMark size={56} /><span className="spinner" /></main>;
  if (!account) return <Welcome>
    <div className="stack">
      {isNative && <NativeSocialButtons />}
      <SignUpButton mode="modal"><button className={isNative ? 'secondary lg' : 'primary lg'}>Create an account</button></SignUpButton>
      <SignInButton mode="modal"><button className="secondary lg">{isNative ? 'Sign in with email' : 'I already have an account'}</button></SignInButton>
    </div>
  </Welcome>;
  return <App key={userId} account={account} />;
}

const PROVIDERS: Array<[NativeOAuthProvider, string]> = [['google', 'Google'], ['apple', 'Apple'], ['facebook', 'Facebook']];

function NativeSocialButtons() {
  const clerk = useClerk();
  const [busy, setBusy] = useState<NativeOAuthProvider | null>(null);
  const [error, setError] = useState('');
  const start = async (provider: NativeOAuthProvider) => {
    setBusy(provider);
    setError('');
    try {
      await signInWithProvider(clerk, provider);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  return <>
    {PROVIDERS.map(([id, label], i) => <button key={id} className={i === 0 ? 'primary lg' : 'secondary lg'} disabled={busy !== null}
      onClick={() => void start(id)}>{busy === id ? 'Waiting for browser…' : `Continue with ${label}`}</button>)}
    {error && <p className="error">{error}</p>}
  </>;
}
