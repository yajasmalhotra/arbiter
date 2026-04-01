import type { ReactNode } from "react";

import "./globals.css";

import { AppHeader } from "@/components/app-header";
import { Providers } from "@/components/providers";
import { Sidebar } from "@/components/sidebar";

export const metadata = {
  title: "Arbiter Control Plane",
  description: "Policy and rollout governance for Arbiter"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen font-sans">
        <Providers>
          <div className="flex min-h-screen">
            <Sidebar />
            <div className="flex min-w-0 flex-1 flex-col">
              <AppHeader />
              <main className="flex-1 p-6 md:p-8">{children}</main>
            </div>
          </div>
        </Providers>
      </body>
    </html>
  );
}
