import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Mediaplán — Fragile",
  description: "Plánování a průběžné vyhodnocování mediálních kampaní",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="cs">
      <head>
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Poppins:ital,wght@0,200;0,300;0,500;0,600;1,300&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
