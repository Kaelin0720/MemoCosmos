import { PRODUCT_NAME } from "@/lib/product";
import type { Metadata } from "next";
import { SpaceShell } from "@/components/space-shell";
import "@/styles/globals.css";
import "@/styles/cosmos.css";

export const metadata: Metadata = {
  title: `${PRODUCT_NAME} · Second Brain`,
  description: "Your personal memory universe. Remember, connect and revisit.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body className="cosmic-universe">
        <SpaceShell>{children}</SpaceShell>
      </body>
    </html>
  );
}
