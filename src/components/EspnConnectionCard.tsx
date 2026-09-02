"use client";

import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { ChevronDown } from "lucide-react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Panel, SectionHeader, Chip, Spinner, StatBlock, type ChipProps } from "@/components/broadcast";
import { cn } from "@/lib/utils";

interface EspnConnectionCardProps {
  leagueId: Id<"leagues">;
  /** Commissioners see the test/save controls; members see status only. */
  isCommissioner: boolean;
}

function relativeTime(timestamp: number | undefined, fallback: string): string {
  if (!timestamp) return fallback;
  return formatDistanceToNow(new Date(timestamp), { addSuffix: true });
}

export function EspnConnectionCard({ leagueId, isCommissioner }: EspnConnectionCardProps) {
  const connection = useQuery(api.leagues.getEspnConnection, { leagueId });
  const testConnection = useAction(api.espnSync.testEspnConnection);
  const updateCredentials = useMutation(api.leagues.updateEspnCredentials);

  const [espnS2, setEspnS2] = useState("");
  const [swid, setSwid] = useState("");
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [testMessage, setTestMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  const runTest = async () => {
    const trimmedS2 = espnS2.trim();
    const trimmedSwid = swid.trim();
    const result = await testConnection({
      leagueId,
      espnS2: trimmedS2 || undefined,
      swid: trimmedSwid || undefined,
    });
    setTestMessage({ ok: result.ok, text: result.message });
    return result;
  };

  const handleTest = async () => {
    setIsTesting(true);
    try {
      const result = await runTest();
      if (!result.ok) {
        toast.error("ESPN connection test failed", { description: result.message });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Please try again.";
      setTestMessage({ ok: false, text: message });
      toast.error("ESPN connection test failed", { description: message });
    } finally {
      setIsTesting(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      // Always re-test the currently typed values before saving, so we never
      // persist cookies that don't actually work.
      const result = await runTest();
      if (!result.ok) {
        toast.error("Couldn't save credentials", {
          description: "Fix the connection test failure above before saving.",
        });
        return;
      }

      await updateCredentials({ leagueId, espnS2: espnS2.trim(), swid: swid.trim() });

      toast.success("ESPN credentials saved", {
        description: result.leagueName ? `Connected to ${result.leagueName}.` : "Connection verified and saved.",
      });
      setEspnS2("");
      setSwid("");
    } catch (error) {
      toast.error("Failed to save ESPN credentials", {
        description: error instanceof Error ? error.message : "Please try again or contact support.",
      });
    } finally {
      setIsSaving(false);
    }
  };

  if (connection === undefined) {
    return (
      <Panel padding="md">
        <SectionHeader title="ESPN connection" kicker="Credentials" />
        <div className="mt-6 flex items-center gap-2 text-sm text-bc-text-2">
          <Spinner size={14} />
          Checking connection status
        </div>
      </Panel>
    );
  }

  const statusChip: { variant: ChipProps["variant"]; label: string } =
    !connection.isPrivate && !connection.hasCredentials
      ? { variant: "muted", label: "Public league — no cookies needed" }
      : connection.credentialStatus === "valid"
        ? { variant: "win", label: "Connected" }
        : connection.credentialStatus === "invalid"
          ? { variant: "red", label: "Cookies rejected" }
          : { variant: "outline", label: "Not checked" };

  const canSave = Boolean(espnS2.trim() && swid.trim());

  return (
    <Panel padding="md">
      <SectionHeader
        title="ESPN connection"
        kicker="Credentials"
        actions={<Chip variant={statusChip.variant}>{statusChip.label}</Chip>}
      />

      <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
        <StatBlock label="Last checked" value={relativeTime(connection.credentialCheckedAt, "Never checked")} />
        <StatBlock label="Last synced" value={relativeTime(connection.lastSyncedAt, "Never synced")} />
      </div>

      {connection.credentialError && (
        <p className="mt-4 border-l-2 border-l-bc-red-deep pl-3 text-sm text-bc-red-text">
          {connection.credentialError}
        </p>
      )}

      {isCommissioner && (
        <div className="mt-6 flex flex-col gap-4 border-t border-bc-hairline pt-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="espn-connection-s2">espn_s2</Label>
              <Input
                id="espn-connection-s2"
                type="password"
                value={espnS2}
                onChange={(e) => setEspnS2(e.target.value)}
                placeholder="Paste the espn_s2 cookie value"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="espn-connection-swid">SWID</Label>
              <Input
                id="espn-connection-swid"
                type="password"
                value={swid}
                onChange={(e) => setSwid(e.target.value)}
                placeholder="{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" onClick={handleTest} disabled={isTesting || isSaving}>
              {isTesting && <Spinner size={14} />}
              {isTesting ? "Testing" : "Test"}
            </Button>
            <Button type="button" onClick={handleSave} disabled={isSaving || isTesting || !canSave}>
              {isSaving && <Spinner size={14} className="[&>span]:bg-white" />}
              {isSaving ? "Saving" : "Save"}
            </Button>
            {testMessage && (
              <span className={cn("text-sm", testMessage.ok ? "text-bc-win" : "text-bc-red-text")}>
                {testMessage.text}
              </span>
            )}
          </div>

          <div>
            <button
              type="button"
              onClick={() => setShowHelp((prev) => !prev)}
              className="flex items-center gap-1.5 text-sm font-semibold text-bc-text-2 hover:text-bc-ink"
              aria-expanded={showHelp}
            >
              <ChevronDown className={cn("size-4 transition-transform", showHelp && "rotate-180")} />
              How to find these
            </button>
            {showHelp && (
              <div className="mt-3 border border-bc-hairline bg-bc-panel-2 p-4 text-sm leading-relaxed text-bc-text-2">
                <ol className="list-decimal space-y-1.5 pl-5">
                  <li>Sign in at espn.com in Chrome.</li>
                  <li>
                    Open DevTools (F12) and go to Application &rarr; Cookies &rarr; https://www.espn.com.
                  </li>
                  <li>
                    Copy the <strong className="text-bc-ink">espn_s2</strong> value and the{" "}
                    <strong className="text-bc-ink">SWID</strong> value (SWID includes the surrounding
                    braces).
                  </li>
                </ol>
                <p className="mt-3 text-bc-text-3">
                  espn_s2 expires periodically, so you may need to repeat this if syncs start failing. A
                  public ESPN league (&quot;Viewable by public&quot; in ESPN league settings) needs no
                  cookies at all.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}
