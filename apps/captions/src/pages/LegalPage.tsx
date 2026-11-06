import { Link } from "react-router";

/**
 * /privacy, /terms, /data-deletion: public, no login (Meta, Google and TikTok ask for these URLs when an app is
 * registered for Settings → Connectors). Written from what the code does; change it with the code.
 */
export const LEGAL_PATHS = ["/privacy", "/terms", "/data-deletion"] as const;
// The operator sets these in the web build (VITE_LEGAL_CONTACT, VITE_LEGAL_HOSTING); the defaults say nothing about who runs it.
const CONTACT = (import.meta.env.VITE_LEGAL_CONTACT as string | undefined)?.trim() ?? "";
const HOSTING = (import.meta.env.VITE_LEGAL_HOSTING as string | undefined)?.trim() || "the operator of this server";
const UPDATED = "6 November 2026";

const h2 = "mt-8 text-base font-semibold text-zinc-100";
const p = "mt-2 text-sm leading-relaxed text-zinc-300";
const li = "mt-1 text-sm leading-relaxed text-zinc-300";

function ContactLink({ subject = "" }: { subject?: string }) {
  if (!CONTACT) return <>the operator of this server</>;
  return (
    <a href={`mailto:${CONTACT}${subject}`} className="underline">
      {CONTACT}
    </a>
  );
}

function Privacy() {
  return (
    <>
      <h1 className="text-2xl font-semibold">Privacy policy</h1>
      <p className={p}>
        Creator Toolset (this site, its Mac app and its iPhone app) helps creators research, write, caption, edit and
        measure their content. This page says what we keep, why, and how to have it deleted.
      </p>
      <h2 className={h2}>What we keep</h2>
      <ul className="mt-2 list-disc pl-5">
        <li className={li}>Your account: username, a hash of your password, your role, and when you signed in.</li>
        <li className={li}>What you make and upload: projects, videos, captions, Workshop sessions, notes, and the files you add to Knowledge.</li>
        <li className={li}>
          Accounts you connect (Instagram, Facebook Pages, YouTube, TikTok): the access token the platform gives us, your profile name and
          picture, follower counts, your posts and their numbers (views, likes, comments, shares, saves, reach, watch time), and comments on
          your own posts. Only what the permissions you approve allow.
        </li>
        <li className={li}>Public profiles and posts you add by handle, read with your own Apify key.</li>
        <li className={li}>Keys you give us (an Apify key, an Instagram session): kept on our server, readable only by your account, never shown back.</li>
      </ul>
      <h2 className={h2}>What we do with it</h2>
      <p className={p}>
        Only what you use the tools for: show you your numbers, compare posts, and give the AI the material for your own writing and
        editing. We don't sell data, don't show ads, and don't use your data to train AI models.
      </p>
      <h2 className={h2}>Who else sees it</h2>
      <ul className="mt-2 list-disc pl-5">
        <li className={li}>The AI provider you connect yourself (for example Claude or Codex on your own Mac, on your own subscription) receives the material for each job you run.</li>
        <li className={li}>Apify, when you read public profiles with your own Apify key.</li>
        <li className={li}>Hosting: {HOSTING}.</li>
        <li className={li}>People you share something with, through a share link you make.</li>
      </ul>
      <h2 className={h2}>How long</h2>
      <p className={p}>
        Uploaded media on standard accounts is deleted after 14 days without use (28 days for team accounts). Connected-account data stays
        until you disconnect the account or delete your account. Disconnecting an account deletes its token and the data we read with it; an
        Instagram account's posts copied into your Content Analyzer stay there until you delete that account in the Analyzer.
      </p>
      <h2 className={h2}>Deleting your data</h2>
      <p className={p}>
        Disconnect any account in Settings → Connectors, or ask us to delete everything: see <Link to="/data-deletion" className="underline">data deletion</Link>.
      </p>
      <h2 className={h2}>Contact</h2>
      <p className={p}>
        Contact: <ContactLink />.
      </p>
    </>
  );
}

function Terms() {
  return (
    <>
      <h1 className="text-2xl font-semibold">Terms of service</h1>
      <p className={p}>By using Creator Toolset you agree to these terms.</p>
      <h2 className={h2}>Your account and your content</h2>
      <p className={p}>
        Your content stays yours. You give us permission to store and process it only to run the tools for you. You are responsible for
        having the rights to what you upload and for keeping your login safe.
      </p>
      <h2 className={h2}>Connected platforms and your own keys</h2>
      <p className={p}>
        When you connect Instagram, Facebook, YouTube or TikTok, you also follow those platforms' terms. AI providers and Apify run on your
        own accounts and plans; their costs are yours.
      </p>
      <h2 className={h2}>Fair use</h2>
      <p className={p}>
        Don't use the service to break the law, to scrape or harass people, to upload anything you have no right to, or to get around a
        platform's limits. We can suspend accounts that do.
      </p>
      <h2 className={h2}>The service</h2>
      <p className={p}>
        We work to keep it running and your data safe, but the service is provided as it is, and tools change. We are not liable for lost
        profits or indirect damages, as far as the law allows.
      </p>
      <h2 className={h2}>Contact</h2>
      <p className={p}>
        Contact: <ContactLink />.
      </p>
    </>
  );
}

function DataDeletion() {
  return (
    <>
      <h1 className="text-2xl font-semibold">Deleting your data</h1>
      <h2 className={h2}>One connected account</h2>
      <p className={p}>
        Sign in, open Settings → Connectors and press Disconnect on the account. Its access token and the data read with it are deleted at
        once (an Instagram account's copy in the Content Analyzer is deleted from the Analyzer). You can also remove Creator Toolset from the platform's own settings (Facebook: Settings → Business integrations; Google:
        myaccount.google.com → Security → Third-party access; TikTok: Settings → Security → Manage app permissions).
      </p>
      <h2 className={h2}>Everything</h2>
      <p className={p}>
        Email{" "}
        <ContactLink subject="?subject=Delete%20my%20Creator%20Toolset%20data" />{" "}
        from the address on your account, or name your username. We delete your account and everything it holds (uploads, projects,
        Workshop sessions, Knowledge, connected accounts and their tokens) within 30 days and confirm by email.
      </p>
    </>
  );
}

export default function LegalPage({ page }: { page: (typeof LEGAL_PATHS)[number] }) {
  return (
    <div className="min-h-dvh bg-[#0b0b10] text-zinc-100">
      <div className="mx-auto max-w-2xl px-6 py-12">
        <Link to="/" className="text-sm text-zinc-500 hover:text-zinc-300">
          Creator Toolset
        </Link>
        <div className="mt-6">{page === "/privacy" ? <Privacy /> : page === "/terms" ? <Terms /> : <DataDeletion />}</div>
        <p className="mt-10 text-xs text-zinc-600">
          Last updated {UPDATED} ·{" "}
          {LEGAL_PATHS.map((path, i) => (
            <span key={path}>
              {i > 0 && " · "}
              <Link to={path} className="hover:text-zinc-400">
                {path === "/privacy" ? "Privacy" : path === "/terms" ? "Terms" : "Data deletion"}
              </Link>
            </span>
          ))}
        </p>
      </div>
    </div>
  );
}
