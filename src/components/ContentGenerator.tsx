/* eslint-disable @typescript-eslint/no-unused-vars */

"use client";

import { useState, useEffect } from "react";
import { TradeRumorDialog, type TradeRumorData } from "./TradeRumorDialog";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { contentTemplates, creditCostFor } from "@/lib/ai/content-templates";
import { SeasonSelector } from "./SeasonSelector";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Sparkles, Zap, Clock, CreditCard, Users, MessageSquare } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Panel,
  SectionHeader,
  PersonaAvatar,
  StatBlock,
  Spinner,
  writerRoster,
  personasForContentType,
  defaultPersonaFor,
  isSelectableContentType,
  contentTypeLabel,
} from "@/components/broadcast";
import {
  PrintDeadlineField,
  MIN_LEAD_MS,
  defaultPrintDeadline,
  formatPrintDeadline,
} from "@/components/PrintDeadlineField";
import { CreditWallet, useCreditBalance } from "@/components/CreditWallet";
import { cn } from "@/lib/utils";

interface ContentGeneratorProps {
  leagueId: Id<"leagues">;
  isCommissioner: boolean;
}

// Writers come from the roster (spec §3) — retired personas are never selectable.

interface ContentTypeOption {
  value: string;
  label: string;
  credits: number;
}

/**
 * The rundown, grouped as the desk thinks about it. Names and credit costs are never
 * restated here: the label comes from the roster's display map and the cost from the
 * type's own template, so a picker entry can't drift from what the mutation charges.
 * A type with no template is dropped (spec §1.5 / §8.5) and reappears by itself the
 * moment its template ships.
 */
function buildOptions(types: string[]): ContentTypeOption[] {
  return types.filter(isSelectableContentType).map((value) => ({
    value,
    label: contentTypeLabel(value),
    credits: contentTemplates[value].creditCost,
  }));
}

const CONTENT_TYPE_GROUPS: { label: string; options: ContentTypeOption[] }[] = [
  {
    label: "Weekly content",
    types: [
      "weekly_recap",
      "weekly_preview",
      "power_rankings",
      "waiver_wire_report",
      "mock_draft",
      "draft_rankings",
      "draft_strategy_guide",
    ],
  },
  {
    label: "Special content",
    types: [
      "trade_analysis",
      "rivalry_week_special",
      "emergency_hot_takes",
      "trade_rumor_mill",
      "trade_block_tuesday",
      "team_name_power_rankings",
      "player_glazing",
    ],
  },
  {
    label: "Season content",
    types: [
      "mid_season_awards",
      "playoff_picture",
      "championship_manifesto",
      "season_recap",
      "commissioner_corner",
      "hall_of_shame",
    ],
  },
]
  .map((group) => ({ label: group.label, options: buildOptions(group.types) }))
  .filter((group) => group.options.length > 0);

const PREMIUM_CONTENT_TYPES: ContentTypeOption[] = buildOptions([
  "custom_roast",
  "season_welcome",
]);

const formSchema = z.object({
  contentType: z.string().min(1, "Please select a content type"),
  persona: z.string().min(1, "Please select a persona"),
  seasonId: z.number().optional(),
  week: z.number().optional(),
  customContext: z.string().optional(),
  requestComments: z.boolean(),
  articleGenerationTime: z.date().optional(),
  targetUserIds: z.array(z.string()).optional(),
});

function ContentTypeCard({
  option,
  selected,
  onSelect,
  tone = "default",
}: {
  option: ContentTypeOption;
  selected: boolean;
  onSelect: () => void;
  tone?: "default" | "premium";
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "flex items-center justify-between gap-3 border px-4 py-3 text-left transition-colors",
        selected
          ? "border-bc-red bg-bc-red/10"
          : tone === "premium"
            ? "border-bc-red-deep/40 bg-bc-panel-2 hover:border-bc-red-deep"
            : "border-bc-hairline bg-bc-panel-2 hover:border-bc-border-strong"
      )}
    >
      <span className="text-[15px] font-semibold text-bc-ink">{option.label}</span>
      <span className="flex flex-none items-baseline gap-1">
        <span className="bc-num text-[16px] text-bc-ink">{option.credits}</span>
        <span className="bc-label-sm text-bc-text-3">cr</span>
      </span>
    </button>
  );
}

export function ContentGenerator({ leagueId, isCommissioner }: ContentGeneratorProps) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [selectedSeason, setSelectedSeason] = useState<number | null>(null);
  const [selectedWeek, setSelectedWeek] = useState<number | null>(null);
  const [showTradeRumorDialog, setShowTradeRumorDialog] = useState(false);
  const [requestComments, setRequestComments] = useState(false);
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);

  const createGenerationRequest = useMutation(api.aiContent.createGenerationRequest);
  const createGenerationWithComments = useMutation(api.aiContent.createGenerationWithComments);
  const completedWeeks = useQuery(api.matchups.getCompletedWeeks, { leagueId });
  const currentUserTeam = useQuery(api.teams.getCurrentUserTeam, { leagueId });
  const claimedTeams = useQuery(api.teams.getClaimedTeams, { leagueId });
  // Shared with the CreditWallet strip mounted below, so the balance is read
  // from a single query rather than each duplicating `getUserCredits`.
  const { balance: creditBalance } = useCreditBalance();

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      contentType: "",
      persona: "",
      seasonId: undefined,
      week: undefined,
      customContext: "",
      requestComments: false,
      articleGenerationTime: undefined,
      targetUserIds: [],
    },
  });

  // The writers this content type is written by, default first (spec §3).
  const getRecommendedPersonas = (selectedContentType: string) =>
    selectedContentType ? personasForContentType(selectedContentType) : writerRoster;

  // Watch content type changes
  const contentType = form.watch("contentType");

  // Handle content type change
  useEffect(() => {
    if (contentType === "weekly_recap" && completedWeeks && completedWeeks.length > 0) {
      // Set default to most recent completed week
      const mostRecentSeason = completedWeeks[0];
      const mostRecentWeek = mostRecentSeason.weeks[mostRecentSeason.weeks.length - 1];

      setSelectedSeason(mostRecentSeason.seasonId);
      setSelectedWeek(mostRecentWeek);
      form.setValue("seasonId", mostRecentSeason.seasonId);
      form.setValue("week", mostRecentWeek);
    } else if (contentType === "draft_rankings") {
      // For draft rankings, use current year instead of most recent completed season
      // since we want to analyze the current season's draft, not last season's
      const currentYear = new Date().getFullYear();

      setSelectedSeason(currentYear);
      setSelectedWeek(null); // No week needed for draft rankings
      form.setValue("seasonId", currentYear);
      form.setValue("week", undefined);
    } else if (contentType !== "weekly_recap" && contentType !== "draft_rankings") {
      // Clear season/week for other content types
      setSelectedSeason(null);
      setSelectedWeek(null);
      form.setValue("seasonId", undefined);
      form.setValue("week", undefined);
    }
  }, [contentType, completedWeeks, form]);

  // The writer follows the content type: switching type selects that type's
  // default writer unless the current pick is already one of its writers.
  useEffect(() => {
    if (!contentType) return;
    const eligible = personasForContentType(contentType);
    const current = form.getValues("persona");
    if (!current || !eligible.some((writer) => writer.slug === current)) {
      form.setValue("persona", defaultPersonaFor(contentType), { shouldValidate: true });
    }
  }, [contentType, form]);

  const handleGenerate = async (values: z.infer<typeof formSchema>) => {
    // If it's a trade rumor, show the dialog first
    if (values.contentType === "trade_rumor_mill") {
      setShowTradeRumorDialog(true);
      return;
    }

    setIsGenerating(true);
    try {
      // Check if we should request comments first
      if (values.requestComments && values.targetUserIds && values.targetUserIds.length > 0) {
        if (!values.articleGenerationTime) {
          toast.error("Pick when we go to print");
          return;
        }

        // The 15-minute minimum is the manager's floor: a deadline inside it means
        // nobody can realistically answer before the story runs.
        if (values.articleGenerationTime.getTime() < Date.now() + MIN_LEAD_MS) {
          toast.error("That deadline is too soon", {
            description: "Give the league at least 15 minutes to answer.",
          });
          return;
        }

        // For draft-related content, we need to pass draft data through
        // The backend will fetch the draft data when creating comment requests
        await createGenerationWithComments({
          leagueId,
          type: values.contentType,
          persona: values.persona,
          customContext: values.customContext || undefined,
          seasonId: values.seasonId,
          week: values.week,
          requestComments: true,
          articleGenerationTime: values.articleGenerationTime.getTime(),
          targetUserIds: values.targetUserIds,
        });

        toast.success("Sam is reaching out for comment", {
          description: `${values.targetUserIds.length} team${values.targetUserIds.length > 1 ? 's' : ''} asked. We go to print ${formatPrintDeadline(values.articleGenerationTime).toLowerCase()}.`,
        });
      } else {
        // Regular generation without comments
        await createGenerationRequest({
          leagueId,
          type: values.contentType,
          persona: values.persona,
          customContext: values.customContext || undefined,
          seasonId: values.seasonId,
          week: values.week,
        });

        toast.success("Content generation started!", {
          description: "Your article will be ready in a few moments.",
        });
      }

      // Reset form
      form.reset();
      setRequestComments(false);
      setSelectedUserIds([]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      if (message.startsWith("Insufficient credits")) {
        toast.error("Not enough credits", { description: message });
      } else {
        toast.error("Failed to generate content", { description: message });
      }
    } finally {
      setIsGenerating(false);
    }
  };

  const handleTradeRumorConfirm = async (rumorData: TradeRumorData) => {
    setIsGenerating(true);


    try {
      // Build context string for the trade rumor
      const contextParts = [];

      if (rumorData.rumorType === "my_trade") {
        contextParts.push("Rumor source wants to trade their player(s).");
      } else {
        contextParts.push("Rumor about another team's trade offer.");
      }

      if (rumorData.targetTeamId) {
        contextParts.push(`Offering team ID: ${rumorData.targetTeamId}`);
      }

      contextParts.push(`Players involved: ${rumorData.playersInvolved.join(", ")}`);

      if (rumorData.additionalContext) {
        contextParts.push(`Additional context: ${rumorData.additionalContext}`);
      }

      await createGenerationRequest({
        leagueId,
        type: "trade_rumor_mill",
        persona: "dex-alvarez", // The transactions desk owns The Asking Price (spec §3)
        customContext: contextParts.join(" | "),
        tradeRumorData: rumorData, // Pass the structured data
      });

      toast.success("Sent to the transactions desk", {
        description: "Dex Alvarez is working the story.",
      });

      // Reset form and dialog state
      form.reset();

      setShowTradeRumorDialog(false);
    } catch (error) {
      toast.error("Failed to file the story", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setIsGenerating(false);
    }
  };

  const selectedContentType = form.watch("contentType");
  const selectedPersona = form.watch("persona");
  const selectedTemplate = selectedContentType ? contentTemplates[selectedContentType] : null;
  const recommendedPersonas = getRecommendedPersonas(selectedContentType);
  // What the server will actually charge: the template price plus 5 credits
  // per manager asked for comment (`creditCostFor`, spec §10.1) - so the
  // wallet strip and the disabled state agree with `createGenerationWithComments`.
  const requiredCredits = selectedContentType
    ? creditCostFor(selectedContentType, requestComments ? selectedUserIds.length : 0)
    : undefined;
  const insufficientCredits =
    requiredCredits != null && creditBalance != null && creditBalance < requiredCredits;

  return (
    <Panel padding="lg" className="mx-auto w-full max-w-4xl">
      <div className="flex flex-col items-center gap-2 pb-8 text-center">
        <span className="bc-label text-bc-text-2">Production desk</span>
        <div className="flex items-center gap-2.5">
          <Sparkles className="size-6 text-bc-red-text" />
          <h2 className="font-display text-[26px] font-extrabold uppercase tracking-[0.01em] text-bc-ink sm:text-[30px]">
            AI content generator
          </h2>
        </div>
        <p className="max-w-md text-[15px] text-bc-text-2">
          Generate engaging fantasy football content with AI-powered personas.
        </p>
      </div>

      <CreditWallet
        leagueId={leagueId}
        requiredCredits={requiredCredits}
        className="mb-7 sm:mb-8"
      />

      <Form {...form}>
        <form onSubmit={form.handleSubmit(handleGenerate)} className="flex flex-col gap-7 sm:gap-8">
          {/* Content Type Selection */}
          <FormField
            control={form.control}
            name="contentType"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="flex items-center gap-2 text-base font-semibold">
                  <Zap className="size-4" />
                  Content type
                </FormLabel>
                <FormControl>
                  <div role="radiogroup" className="flex flex-col gap-5">
                    {CONTENT_TYPE_GROUPS.map((group) => (
                      <div key={group.label} className="flex flex-col gap-2.5">
                        <span className="bc-label-sm text-bc-text-3">{group.label}</span>
                        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                          {group.options.map((option) => (
                            <ContentTypeCard
                              key={option.value}
                              option={option}
                              selected={field.value === option.value}
                              onSelect={() => field.onChange(option.value)}
                            />
                          ))}
                        </div>
                      </div>
                    ))}

                    {isCommissioner && (
                      <div className="flex flex-col gap-2.5">
                        <span className="bc-label-sm text-bc-text-3">Premium content</span>
                        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                          {PREMIUM_CONTENT_TYPES.map((option) => (
                            <ContentTypeCard
                              key={option.value}
                              option={option}
                              selected={field.value === option.value}
                              onSelect={() => field.onChange(option.value)}
                              tone="premium"
                            />
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </FormControl>
                {selectedTemplate && (
                  <FormDescription>{selectedTemplate.description}</FormDescription>
                )}
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Season/Week Selection for Weekly Recap and Draft Rankings */}
          {(selectedContentType === "weekly_recap" || selectedContentType === "draft_rankings") && (
            (selectedContentType === "weekly_recap" && completedWeeks) ||
            selectedContentType === "draft_rankings"
          ) && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="seasonId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-base font-semibold">Season</FormLabel>
                    <FormControl>
                      <SeasonSelector
                        currentSeason={selectedContentType === "draft_rankings"
                          ? new Date().getFullYear()
                          : (completedWeeks && completedWeeks[0]?.seasonId || new Date().getFullYear())
                        }
                        selectedSeason={field.value || (selectedContentType === "draft_rankings"
                          ? new Date().getFullYear()
                          : (completedWeeks && completedWeeks[0]?.seasonId || new Date().getFullYear()))
                        }
                        onSeasonChange={(season) => {
                          field.onChange(season);
                          setSelectedSeason(season);
                          // Reset week when season changes (only for weekly_recap)
                          if (selectedContentType === "weekly_recap" && completedWeeks) {
                            const seasonData = completedWeeks.find(s => s.seasonId === season);
                            if (seasonData && seasonData.weeks.length > 0) {
                              const defaultWeek = seasonData.weeks[seasonData.weeks.length - 1];
                              setSelectedWeek(defaultWeek);
                              form.setValue("week", defaultWeek);
                            }
                          }
                        }}
                        availableSeasons={selectedContentType === "draft_rankings"
                          ? Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - i)
                          : (completedWeeks ? completedWeeks.map(s => s.seasonId) : [])
                        }
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {selectedContentType === "weekly_recap" && (
                <FormField
                  control={form.control}
                  name="week"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-base font-semibold">Week</FormLabel>
                      <Select
                        onValueChange={(value) => {
                          field.onChange(parseInt(value));
                          setSelectedWeek(parseInt(value));
                        }}
                        value={field.value?.toString()}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select a week..." />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {completedWeeks
                            ?.find(s => s.seasonId === selectedSeason)
                            ?.weeks.map((week) => (
                              <SelectItem key={week} value={week.toString()}>
                                Week {week}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                      <FormDescription>
                        Select a week with completed matchups to recap
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
            </div>
          )}

          {/* Persona Selection */}
          <FormField
            control={form.control}
            name="persona"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-base font-semibold">AI persona</FormLabel>
                <FormControl>
                  <RadioGroup
                    onValueChange={field.onChange}
                    value={field.value}
                    className="grid grid-cols-1 gap-3 sm:grid-cols-2"
                  >
                    {recommendedPersonas.map((persona) => {
                      const selected = field.value === persona.slug;
                      return (
                        <div key={persona.slug} className="flex items-center">
                          <RadioGroupItem value={persona.slug} id={persona.slug} className="sr-only" />
                          <Label
                            htmlFor={persona.slug}
                            className={cn(
                              "flex w-full cursor-pointer items-center gap-3 border p-3.5 transition-colors",
                              selected
                                ? "border-bc-red bg-bc-plate text-bc-plate-fg"
                                : "border-bc-hairline bg-bc-panel-2 hover:border-bc-border-strong"
                            )}
                          >
                            <PersonaAvatar
                              persona={persona.name}
                              size={44}
                              className="border border-bc-border-strong"
                            />
                            <div className="min-w-0 flex-1 text-left">
                              <div className="truncate font-display text-[16px] font-bold uppercase tracking-[0.01em]">
                                {persona.name}
                              </div>
                              <div
                                className={cn(
                                  "truncate text-sm",
                                  selected ? "text-bc-plate-fg/70" : "text-bc-text-3"
                                )}
                              >
                                {persona.role}
                              </div>
                            </div>
                          </Label>
                        </div>
                      );
                    })}
                  </RadioGroup>
                </FormControl>
                <FormDescription>
                  Choose the AI persona that will write your content
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Custom Context */}
          <FormField
            control={form.control}
            name="customContext"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-base font-semibold">
                  Additional context (optional)
                </FormLabel>
                <FormControl>
                  <Textarea
                    placeholder="Add any specific events, rivalries, or context you want included in the content..."
                    className="min-h-[100px] resize-none"
                    {...field}
                  />
                </FormControl>
                <FormDescription>
                  Provide specific details to make your content more personalized and relevant
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Comment Request Section */}
          <Panel lifted padding="md">
            <SectionHeader
              size="sm"
              kicker="Optional"
              title={
                <span className="flex items-center gap-2">
                  <MessageSquare className="size-4" />
                  Request team comments
                </span>
              }
            />
            <p className="mt-3 text-sm text-bc-text-2">
              Gather feedback from league members before generating the article.
            </p>

            <div className="mt-5 flex flex-col gap-4">
              <FormField
                control={form.control}
                name="requestComments"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center justify-between gap-4 border border-bc-hairline bg-bc-panel p-3.5">
                    <div className="flex flex-col gap-0.5">
                      <FormLabel className="text-base">Enable comment requests</FormLabel>
                      <FormDescription>
                        Send questions to selected teams and wait for their responses
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={(checked) => {
                          field.onChange(checked);
                          setRequestComments(checked);
                          if (checked) {
                            // "In 6 hours" is the house default (spec §8.2) — the
                            // deadline is already set before the commissioner
                            // touches anything.
                            if (!form.getValues("articleGenerationTime")) {
                              form.setValue("articleGenerationTime", defaultPrintDeadline());
                            }
                          } else {
                            form.setValue("targetUserIds", []);
                            setSelectedUserIds([]);
                          }
                        }}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              {requestComments && (
                <>
                  <FormField
                    control={form.control}
                    name="articleGenerationTime"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-base font-semibold">We go to print at</FormLabel>
                        <FormControl>
                          <PrintDeadlineField
                            value={field.value}
                            onChange={field.onChange}
                          />
                        </FormControl>
                        <FormDescription>
                          {field.value
                            ? `${formatPrintDeadline(field.value)} — the story runs then with whatever answers are in.`
                            : "Pick when the story runs. It goes to print at that time, answered or not."}
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="targetUserIds"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="flex items-center gap-2">
                          <Users className="size-4" />
                          Select teams to request comments from
                        </FormLabel>
                        <div className="flex max-h-[200px] flex-col gap-2 overflow-y-auto border border-bc-hairline bg-bc-panel p-3.5">
                          {claimedTeams && claimedTeams.length > 0 ? (
                            claimedTeams.map((team) => (
                              <div key={team._id} className="flex items-center gap-2.5">
                                <Checkbox
                                  id={team._id}
                                  checked={field.value?.includes(team._id)}
                                  onCheckedChange={(checked: boolean) => {
                                    const currentValues = field.value || [];
                                    if (checked) {
                                      field.onChange([...currentValues, team._id]);
                                      setSelectedUserIds([...currentValues, team._id]);
                                    } else {
                                      const newValues = currentValues.filter(id => id !== team._id);
                                      field.onChange(newValues);
                                      setSelectedUserIds(newValues);
                                    }
                                  }}
                                />
                                <Label
                                  htmlFor={team._id}
                                  className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                                >
                                  {team.name}
                                </Label>
                              </div>
                            ))
                          ) : (
                            <p className="text-sm text-bc-text-2">
                              No teams have been claimed yet. Team members need to claim their teams before you can request comments.
                            </p>
                          )}
                        </div>
                        <FormDescription>
                          Selected teams will receive personalized questions about the article topic
                        </FormDescription>
                      </FormItem>
                    )}
                  />
                </>
              )}
            </div>
          </Panel>

          {/* Generation Summary */}
          {selectedTemplate && selectedPersona && (
            <>
              <Separator />
              <Panel lifted padding="md">
                <SectionHeader
                  size="sm"
                  kicker="Before you generate"
                  title={
                    <span className="flex items-center gap-2">
                      <Clock className="size-4" />
                      Generation summary
                    </span>
                  }
                />
                <div className="mt-5 grid grid-cols-1 gap-6 md:grid-cols-2">
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-between gap-2 text-sm">
                      <span className="font-medium text-bc-text-2">Content type</span>
                      <span className="text-bc-ink">{selectedTemplate.name}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2 text-sm">
                      <span className="font-medium text-bc-text-2">Persona</span>
                      <span className="text-bc-ink">{writerRoster.find(w => w.slug === selectedPersona)?.name ?? selectedPersona}</span>
                    </div>
                    {selectedContentType === "weekly_recap" && selectedSeason && selectedWeek && (
                      <div className="flex items-center justify-between gap-2 text-sm">
                        <span className="font-medium text-bc-text-2">Period</span>
                        <span className="text-bc-ink">{selectedSeason} &middot; Week {selectedWeek}</span>
                      </div>
                    )}
                    {selectedContentType === "draft_rankings" && selectedSeason && (
                      <div className="flex items-center justify-between gap-2 text-sm">
                        <span className="font-medium text-bc-text-2">Season</span>
                        <span className="text-bc-ink">{selectedSeason} draft</span>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-6 sm:justify-end">
                    <StatBlock label="Estimated length" value={`~${selectedTemplate.estimatedWords}w`} />
                    <StatBlock
                      label="Credits required"
                      value={
                        <span className="inline-flex items-center gap-1.5">
                          <CreditCard className="size-4 text-bc-text-3" />
                          {requiredCredits ?? selectedTemplate.creditCost}
                        </span>
                      }
                    />
                  </div>
                </div>
              </Panel>
            </>
          )}

          {/* Generate Button */}
          <Button
            type="submit"
            variant="glow"
            size="lg"
            className="w-full"
            disabled={isGenerating || insufficientCredits}
          >
            {isGenerating ? (
              <>
                <Spinner size={16} className="[&>span]:bg-white" />
                Generating content&hellip;
              </>
            ) : insufficientCredits ? (
              <>
                <CreditCard className="size-4" />
                Not enough credits
              </>
            ) : form.watch("contentType") === "trade_rumor_mill" ? (
              <>
                <Sparkles className="size-4" />
                Configure the listing
              </>
            ) : (
              <>
                <Sparkles className="size-4" />
                Generate content
                {selectedTemplate && <span className="bc-num opacity-80">&middot; {requiredCredits ?? selectedTemplate.creditCost} credits</span>}
              </>
            )}
          </Button>
        </form>
      </Form>

      {/* Trade Rumor Dialog */}
      <TradeRumorDialog
        open={showTradeRumorDialog}
        onOpenChange={setShowTradeRumorDialog}
        leagueId={leagueId}
        currentTeamId={currentUserTeam?._id}
        onConfirm={handleTradeRumorConfirm}
      />
    </Panel>
  );
}
