import { createFileRoute } from "@tanstack/react-router";

import { getTrains } from "@/lib/trains/aggregate.server";

/**
 * GET /api/trains — snapshot of every live train from all configured sources,
 * in the common Train format (see src/lib/trains/types.ts).
 */
export const Route = createFileRoute("/api/trains")({
  server: {
    handlers: {
      GET: async () => {
        const data = await getTrains();
        return Response.json(data, {
          headers: {
            "Cache-Control": "public, max-age=5, s-maxage=10",
            "Access-Control-Allow-Origin": "*",
          },
        });
      },
    },
  },
});
