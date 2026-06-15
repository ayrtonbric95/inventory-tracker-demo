import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Don't advertise the framework/version.
  poweredByHeader: false,

  async headers() {
    return [
      {
        // Public portfolio demo: indexable and embeddable. Keep only the
        // non-restrictive hardening headers.
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
