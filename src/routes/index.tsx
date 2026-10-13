import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Blank Website" },
      { name: "description", content: "A blank website." },
      { property: "og:title", content: "Blank Website" },
      { property: "og:description", content: "A blank website." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Index,
});

function Index() {
  return <main className="min-h-screen bg-background" />;
}
