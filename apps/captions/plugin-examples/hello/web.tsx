import { Hand } from "lucide-react";
import { defineWebPlugin } from "../../src/lib/plugin";

// Example page at /hello, added to the app's routes by the generated src/plugins.gen.ts.
function HelloPage() {
  return (
    <main className="p-6">
      <h1 className="text-xl font-semibold">Hello plug-in</h1>
      <p>This page comes from a plug-in folder, not from the core app.</p>
    </main>
  );
}

// Its Settings section (admins only) and its Home tile, in the Tools row. The tile is hidden for an account that has
// the "hello" gate switched off.
function HelloSettings() {
  return <p className="text-sm text-muted-foreground">This section comes from a plug-in folder too.</p>;
}

export default defineWebPlugin({
  id: "hello",
  routes: [{ path: "/hello", element: <HelloPage /> }],
  tiles: [{ stage: "Tools", to: "/hello", icon: Hand, name: "Hello", desc: "The example plug-in's page.", gate: "hello" }],
  settings: [{ id: "hello", title: "Hello plug-in", icon: Hand, adminOnly: true, body: <HelloSettings /> }],
});
