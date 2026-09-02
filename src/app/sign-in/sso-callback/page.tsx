import { AuthenticateWithRedirectCallback } from "@clerk/nextjs";

import { LoadingScreen } from "@/components/broadcast";

export default function SSOCallback() {
  // Handle the redirect flow by rendering the prebuilt <AuthenticateWithRedirectCallback/> component.
  // This is the final step in the OAuth/SSO flow.
  return (
    <div className="bc-scan relative min-h-screen overflow-hidden bg-bc-ground">
      <div
        className="pointer-events-none absolute -top-24 -right-24 h-[420px] w-[420px] opacity-70"
        style={{
          background:
            "radial-gradient(circle, rgba(201,22,24,0.22) 0%, rgba(201,22,24,0.08) 35%, rgba(14,12,12,0) 68%)",
        }}
        aria-hidden="true"
      />
      <div className="relative">
        <LoadingScreen message="Signing you in" />
      </div>
      <AuthenticateWithRedirectCallback />
    </div>
  );
}
