import type { MetadataRoute } from "next";

// Public portfolio demo — allow indexing.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
  };
}
