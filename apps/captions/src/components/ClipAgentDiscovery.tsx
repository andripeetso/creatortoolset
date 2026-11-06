import { useEffect } from "react";

/**
 * Client fallback so a hydrated clip page still advertises the agent
 * APIs if the HTML was served without the server-side injection.
 */
export function ClipAgentDiscovery({
  clipId,
  title,
  status,
}: {
  clipId: string;
  title: string;
  status: string;
}) {
  useEffect(() => {
    const origin = window.location.origin;
    const agentContextUrl = `${origin}/api/agent-context.json?id=${encodeURIComponent(clipId)}`;
    const payload = {
      type: "agent-native.clip.discovery",
      version: 2,
      clipId,
      title,
      recordingStatus: status,
      agentContextUrl,
      instructions:
        "Fetch agentContextUrl for the transcript and JPEG frame URLs; this works without a browser. Use apis.transcript for the complete transcript. Fetch recommendedFrames / apis.frame.urlTemplate to SEE the screen, not just read the transcript.",
    };

    const link =
      document.querySelector<HTMLLinkElement>(
        'link[rel="alternate"][title="Agent-readable clip context"]',
      ) ?? document.createElement("link");
    link.rel = "alternate";
    link.type = "application/json";
    link.href = agentContextUrl;
    link.title = "Agent-readable clip context";
    if (!link.parentNode) document.head.appendChild(link);

    let script = document.getElementById(
      "clips-agent-context",
    ) as HTMLScriptElement | null;
    if (!script) {
      script = document.createElement("script");
      script.id = "clips-agent-context";
      script.type = "application/agent-native+json";
      document.head.appendChild(script);
    }
    script.textContent = JSON.stringify(payload);

    return () => {
      link.remove();
      script?.remove();
    };
  }, [clipId, title, status]);

  return null;
}
