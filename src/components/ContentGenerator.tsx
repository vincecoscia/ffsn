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
import { contentTemplates } from "@/lib/ai/content-templates";
import { contentTypePersonaMap } from "@/lib/ai/persona-prompts";
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
import { DateTimePicker } from "@/components/ui/date-time-picker";
import { Panel, SectionHeader, PersonaAvatar, StatBlock, Spinner } from "@/components/broadcast";
import { cn } from "@/lib/utils";

interface ContentGeneratorProps {
  leagueId: Id<"leagues">;
  isCommissioner: boolean;
}

const personas = [
  { id: "mel-diaper", name: "Mel Diaper", tagline: "The Draft Disaster" },
  { id: "stan-deviation", name: "Stan Deviation", tagline: "The Analytics Overlord" },
  { id: "vinny-marinara", name: "Vinny \"The Sauce\" Marinara", tagline: "Trade Rumor Mogul" },
  { id: "chad-thunderhype", name: "Chad Thunderhype", tagline: "The Glaze God" },
  { id: "rick-two-beers", name: "Rick \"Two Beers\" O'Sullivan", tagline: "The Drunk Uncle" },
  { id: "mike-harrison", name: "Mike Harrison", tagline: "The Professional Analyst" },
];

interface ContentTypeOption {
  value: string;
  label: string;
  credits: number;
}

const CONTENT_TYPE_GROUPS: { label: string; options: ContentTypeOption[] }[] = [
  {
    label: "Weekly content",
    options: [
      { value: "weekly_recap", label: "Weekly recap", credits: 10 },
      { value: "weekly_preview", label: "Weekly preview", credits: 10 },
      { value: "power_rankings", label: "Power rankings", credits: 8 },
      { value: "waiver_wire_report", label: "Waiver wire report", credits: 12 },
      { value: "mock_draft", label: "Mock draft", credits: 15 },
      { value: "draft_rankings", label: "Post-draft rankings & grades", credits: 15 },
    ],
  },
  {
    label: "Special content",
    options: [
      { value: "trade_analysis", label: "Trade analysis", credits: 5 },
      { value: "rivalry_week_special", label: "Rivalry week special", credits: 10 },
      { value: "emergency_hot_takes", label: "Emergency hot takes", credits: 5 },
      { value: "trade_rumor_mill", label: "Trade rumor leak", credits: 8 },
    ],
  },
  {
    label: "Season content",
    options: [
      { value: "mid_season_awards", label: "Mid-season awards", credits: 12 },
      { value: "championship_manifesto", label: "Championship manifesto", credits: 10 },
      { value: "season_recap", label: "Season recap", credits: 20 },
    ],
  },
];

const PREMIUM_CONTENT_TYPES: ContentTypeOption[] = [
  { value: "custom_roast", label: "Custom roast", credits: 25 },
  { value: "season_welcome", label: "Season welcome package", credits: 30 },
];

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

  // Get recommended personas for selected content type
  const getRecommendedPersonas = (selectedContentType: string) => {
    if (!selectedContentType) return personas;

    const recommended = contentTypePersonaMap[selectedContentType];
    if (!recommended || recommended.includes("any")) return personas;

    return personas.filter(p => recommended.includes(p.id));
  };

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
          toast.error("Please select when the article should be generated");
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

        toast.success("Comment requests sent!", {
          description: `Gathering feedback from ${values.targetUserIds.length} team${values.targetUserIds.length > 1 ? 's' : ''}. Article will be generated on ${values.articleGenerationTime.toLocaleDateString()} at ${values.articleGenerationTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`,
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
      toast.error("Failed to generate content", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
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
        persona: "vinny-marinara", // Always use Vinny for trade rumors
        customContext: contextParts.join(" | "),
        tradeRumorData: rumorData, // Pass the structured data
      });

      toast.success("Trade rumor leaked!", {
        description: "Vinny is working on spreading the word...",
      });

      // Reset form and dialog state
      form.reset();

      setShowTradeRumorDialog(false);
    } catch (error) {
      toast.error("Failed to leak trade rumor", {
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
                    defaultValue={field.value}
                    className="grid grid-cols-1 gap-3 sm:grid-cols-2"
                  >
                    {recommendedPersonas.map((persona) => {
                      const selected = field.value === persona.id;
                      return (
                        <div key={persona.id} className="flex items-center">
                          <RadioGroupItem value={persona.id} id={persona.id} className="sr-only" />
                          <Label
                            htmlFor={persona.id}
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
                                {persona.tagline}
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
                          if (!checked) {
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
                        <FormLabel>Article generation date &amp; time</FormLabel>
                        <FormControl>
                          <DateTimePicker
                            value={field.value}
                            onChange={field.onChange}
                            placeholder="Select when to generate the article"
                            minDate={new Date(Date.now() + 15 * 60 * 1000)} // Minimum 15 minutes from now
                          />
                        </FormControl>
                        <FormDescription>
                          The article will be generated at this exact date and time, regardless of comment responses
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
                      <span className="text-bc-ink">{personas.find(p => p.id === selectedPersona)?.name}</span>
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
                          {selectedTemplate.creditCost}
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
            disabled={isGenerating}
          >
            {isGenerating ? (
              <>
                <Spinner size={16} className="[&>span]:bg-white" />
                Generating content&hellip;
              </>
            ) : form.watch("contentType") === "trade_rumor_mill" ? (
              <>
                <Sparkles className="size-4" />
                Configure trade rumor
              </>
            ) : (
              <>
                <Sparkles className="size-4" />
                Generate content
                {selectedTemplate && <span className="bc-num opacity-80">&middot; {selectedTemplate.creditCost} credits</span>}
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
