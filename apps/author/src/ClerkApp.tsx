import { ClerkProvider, SignInButton, SignUpButton, useAuth, useClerk, useUser } from '@clerk/react';
import { useMemo } from 'react';
import { App } from './App.tsx';
import { createApi, defaultServer, isNative, type Session } from './api.ts';

export function ClerkApp() {
  const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;
  if (!publishableKey || (import.meta.env.PROD && !publishableKey.startsWith('pk_live_'))) {
    return <main className="page narrow"><h1>Sign-in is not configured</h1><p>Set the Clerk publishable key for this build. Release builds require a production Clerk instance.</p></main>;
  }
  if (isNative) {
    return <main className="page narrow"><h1>Continue on the web</h1><p>Account sign-in is currently available in the web app.</p><a href={`${defaultServer()}/author/`}>Open Applets</a></main>;
  }
  return <ClerkProvider publishableKey={publishableKey}
    signInFallbackRedirectUrl={`${window.location.origin}/author/`}
    signUpFallbackRedirectUrl={`${window.location.origin}/author/`}>
    <ClerkAccount />
  </ClerkProvider>;
}

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
  if (!isLoaded) return <main className="page narrow"><p>Loading your account…</p></main>;
  if (!account) return <main className="page narrow">
    <div className="hero"><img src="./icon.png" alt="" width={56} height={56} /><h1>Applets</h1><p className="muted">Small personal apps for your Meta Ray-Ban Display glasses.</p></div>
    <div className="card stack">
      <SignInButton mode="modal"><button className="primary">Sign in</button></SignInButton>
      <SignUpButton mode="modal"><button>Create an account</button></SignUpButton>
    </div>
  </main>;
  return <App key={userId} account={account} />;
}
