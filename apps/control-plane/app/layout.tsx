import type { ReactNode } from "react";

export const metadata = {
  title: "Arbiter Control Plane",
  description: "Policy and rollout governance for Arbiter"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, background: "#0b1220", color: "#e5e7eb" }}>
        <header style={{ padding: "16px 20px", borderBottom: "1px solid #1f2937" }}>
          <h1 style={{ margin: 0, fontSize: 18 }}>Arbiter Control Plane</h1>
        </header>
        <main style={{ padding: 20 }}>{children}</main>
      </body>
    </html>
  );
}
