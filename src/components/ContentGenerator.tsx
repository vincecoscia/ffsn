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
  SelectGroup,
  SelectLabel,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Sparkles, Zap, Clock, CreditCard, Users, MessageSquare } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";

interface ContentGeneratorProps {
  leagueId: Id<"leagues">;
  isCommissioner: boolean;
}

const personas = [
  { id: "mel-diaper", name: "Mel Diaper", tagline: "The Draft Disaster", icon: "🔥" },
  { id: "stan-deviation", name: "Stan Deviation", tagline: "The Analytics Overlord", icon: "📊" },
  { id: "vinny-marinara", name: "Vinny 'The Sauce' Marinara", tagline: "Trade Rumor Mogul", icon: "🕵️" },
  { id: "chad-thunderhype", name: "Chad Thunderhype", tagline: "The Glaze God", icon: "🎉" },
  { id: "rick-two-beers", name: "Rick 'Two Beers' O'Sullivan", tagline: "The Drunk Uncle", icon: "🍺" },
  { id: "mike-harrison", name: "Mike Harrison", tagline: "The Professional Analyst", icon: "📝" },
];

const formSchema = z.object({
  contentType: z.string().min(1, "Please select a content type"),
  persona: z.string().min(1, "Please select a persona"),
  seasonId: z.number().optional(),
  week: z.number().optional(),
  customContext: z.string().optional(),
  requestComments: z.boolean(),
  commentExpirationMinutes: z.number(),
  targetUserIds: z.array(z.string()).optional(),
});

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
      commentExpirationMinutes: 30,
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
          commentExpirationMinutes: values.commentExpirationMinutes,
          targetUserIds: values.targetUserIds,
        });

        toast.success("Comment requests sent!", {
          description: `Gathering feedback from ${values.targetUserIds.length} team${values.targetUserIds.length > 1 ? 's' : ''}. Article will be generated after responses are collected.`,
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
    <Card className="w-full max-w-4xl mx-auto">
      <CardHeader className="text-center">
        <div className="flex items-center justify-center gap-2 mb-2">
          <Sparkles className="h-6 w-6 text-primary" />
          <CardTitle className="text-xl sm:text-2xl font-bold">AI Content Generator</CardTitle>
        </div>
        <CardDescription className="text-sm sm:text-base">
          Generate engaging fantasy football content with AI-powered personas
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6 sm:space-y-8">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleGenerate)} className="space-y-6 sm:space-y-8">
            {/* Content Type Selection */}
            <FormField
              control={form.control}
              name="contentType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-base font-semibold flex items-center gap-2">
                    <Zap className="h-4 w-4" />
                    Content Type
                  </FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger className="h-11 sm:h-12 w-full sm:max-w-xs">
                        <SelectValue placeholder="Select Content Type" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent className="max-h-[60vh] overflow-y-auto sm:min-w-[20rem]">
                      <SelectGroup>
                      <SelectLabel>Weekly Content</SelectLabel>
                        <SelectItem
                          value="weekly_recap"
                          textValue="Weekly Recap"
                          rightAdornment={<Badge variant="secondary">10 credits</Badge>}
                        >
                          Weekly Recap
                        </SelectItem>
                        <SelectItem
                          value="weekly_preview"
                          textValue="Weekly Preview"
                          rightAdornment={<Badge variant="secondary">10 credits</Badge>}
                        >
                          Weekly Preview
                        </SelectItem>
                        <SelectItem
                          value="power_rankings"
                          textValue="Power Rankings"
                          rightAdornment={<Badge variant="secondary">8 credits</Badge>}
                        >
                          Power Rankings
                        </SelectItem>
                        <SelectItem
                          value="waiver_wire_report"
                          textValue="Waiver Wire Report"
                          rightAdornment={<Badge variant="secondary">12 credits</Badge>}
                        >
                          Waiver Wire Report
                        </SelectItem>
                        <SelectItem
                          value="mock_draft"
                          textValue="Mock Draft"
                          rightAdornment={<Badge variant="secondary">15 credits</Badge>}
                        >
                          Mock Draft
                        </SelectItem>
                        <SelectItem
                          value="draft_rankings"
                          textValue="Post-Draft Rankings & Grades"
                          rightAdornment={<Badge variant="secondary">15 credits</Badge>}
                        >
                          Post-Draft Rankings & Grades
                        </SelectItem>
                      </SelectGroup>
                      
                      <SelectGroup>
                        <SelectLabel>Special Content</SelectLabel>
                        <SelectItem
                          value="trade_analysis"
                          textValue="Trade Analysis"
                          rightAdornment={<Badge variant="secondary">5 credits</Badge>}
                        >
                          Trade Analysis
                        </SelectItem>
                        <SelectItem
                          value="rivalry_week_special"
                          textValue="Rivalry Week Special"
                          rightAdornment={<Badge variant="secondary">10 credits</Badge>}
                        >
                          Rivalry Week Special
                        </SelectItem>
                        <SelectItem
                          value="emergency_hot_takes"
                          textValue="Emergency Hot Takes"
                          rightAdornment={<Badge variant="secondary">5 credits</Badge>}
                        >
                          Emergency Hot Takes
                        </SelectItem>
                        <SelectItem
                          value="trade_rumor_mill"
                          textValue="Trade Rumor Leak"
                          rightAdornment={<Badge variant="secondary">8 credits</Badge>}
                        >
                          Trade Rumor Leak
                        </SelectItem>
                      </SelectGroup>
                      
                      <SelectGroup>
                        <SelectLabel>Season Content</SelectLabel>
                        <SelectItem
                          value="mid_season_awards"
                          textValue="Mid-Season Awards"
                          rightAdornment={<Badge variant="secondary">12 credits</Badge>}
                        >
                          Mid-Season Awards
                        </SelectItem>
                        <SelectItem
                          value="championship_manifesto"
                          textValue="Championship Manifesto"
                          rightAdornment={<Badge variant="secondary">10 credits</Badge>}
                        >
                          Championship Manifesto
                        </SelectItem>
                        <SelectItem
                          value="season_recap"
                          textValue="Season Recap"
                          rightAdornment={<Badge variant="secondary">20 credits</Badge>}
                        >
                          Season Recap
                        </SelectItem>
                      </SelectGroup>
                      
                      {isCommissioner && (
                        <SelectGroup>
                          <SelectLabel>Premium Content</SelectLabel>
                          <SelectItem
                            value="custom_roast"
                            textValue="Custom Roast"
                            rightAdornment={<Badge variant="destructive">25 credits</Badge>}
                          >
                            Custom Roast
                          </SelectItem>
                          <SelectItem
                            value="season_welcome"
                            textValue="Season Welcome Package"
                            rightAdornment={<Badge variant="destructive">30 credits</Badge>}
                          >
                            Season Welcome Package
                          </SelectItem>
                        </SelectGroup>
                      )}
                    </SelectContent>
                  </Select>
                  {selectedTemplate && (
                    <FormDescription className="text-sm text-muted-foreground">
                      {selectedTemplate.description}
                    </FormDescription>
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
              <div className="space-y-4">
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
                  <FormLabel className="text-base font-semibold">
                    AI Persona
                  </FormLabel>
                  <FormControl>
                    <RadioGroup
                      onValueChange={field.onChange}
                      defaultValue={field.value}
                      className="grid grid-cols-1 md:grid-cols-2 gap-4"
                    >
                      {recommendedPersonas.map((persona) => (
                        <div key={persona.id} className="flex items-center space-x-2">
                          <RadioGroupItem 
                            value={persona.id} 
                            id={persona.id}
                            className="sr-only peer"
                          />
                          <Label
                            htmlFor={persona.id}
                            className="flex items-start gap-3 p-3 sm:p-4 rounded-lg border-2 cursor-pointer transition-all hover:bg-accent peer-data-[state=checked]:border-primary peer-data-[state=checked]:bg-primary/5 w-full break-words leading-tight"
                          >
                            <span className="text-2xl">{persona.icon}</span>
                            <div className="flex-1 text-left">
                              <div className="font-semibold text-sm sm:text-base">{persona.name}</div>
                              <div className="text-sm text-muted-foreground">
                                {persona.tagline}
                              </div>
                            </div>
                          </Label>
                        </div>
                      ))}
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
                    Additional Context (Optional)
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
            <Card className="border-2">
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center gap-2">
                  <MessageSquare className="h-4 w-4" />
                  Request Team Comments
                </CardTitle>
                <CardDescription>
                  Gather feedback from league members before generating the article
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <FormField
                  control={form.control}
                  name="requestComments"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
                      <div className="space-y-0.5">
                        <FormLabel className="text-base">Enable Comment Requests</FormLabel>
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
                      name="commentExpirationMinutes"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Response Time Limit</FormLabel>
                          <Select 
                            onValueChange={(value) => field.onChange(parseInt(value))} 
                            value={field.value?.toString()}
                          >
                            <FormControl>
                              <SelectTrigger>
                                <SelectValue placeholder="Select time limit" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="15">15 minutes</SelectItem>
                              <SelectItem value="30">30 minutes</SelectItem>
                              <SelectItem value="60">1 hour</SelectItem>
                              <SelectItem value="120">2 hours</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormDescription>
                            Article will generate after this time or when all responses are received
                          </FormDescription>
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="targetUserIds"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="flex items-center gap-2">
                            <Users className="h-4 w-4" />
                            Select Teams to Request Comments From
                          </FormLabel>
                          <div className="space-y-2 rounded-lg border p-3 max-h-[200px] overflow-y-auto">
                            {claimedTeams && claimedTeams.length > 0 ? (
                              claimedTeams.map((team) => (
                                <div key={team._id} className="flex items-center space-x-2">
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
                              <p className="text-sm text-muted-foreground">
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
              </CardContent>
            </Card>

            {/* Generation Summary */}
            {selectedTemplate && selectedPersona && (
              <>
                <Separator />
                <Card className="bg-muted/50">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-lg flex items-center gap-2">
                      <Clock className="h-4 w-4" />
                      Generation Summary
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-1">
                          <span className="font-medium">Content Type:</span>
                          <span className="text-sm">{selectedTemplate.name}</span>
                        </div>
                        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-1">
                          <span className="font-medium">Persona:</span>
                          <span className="text-sm">{personas.find(p => p.id === selectedPersona)?.name}</span>
                        </div>
                        {selectedContentType === "weekly_recap" && selectedSeason && selectedWeek && (
                          <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-1">
                            <span className="font-medium">Period:</span>
                            <span className="text-sm">{selectedSeason} - Week {selectedWeek}</span>
                          </div>
                        )}
                        {selectedContentType === "draft_rankings" && selectedSeason && (
                          <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-1">
                            <span className="font-medium">Season:</span>
                            <span className="text-sm">{selectedSeason} Draft</span>
                          </div>
                        )}
                      </div>
                      <div className="space-y-2">
                        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-1">
                          <span className="font-medium">Estimated Length:</span>
                          <span className="text-sm">~{selectedTemplate.estimatedWords} words</span>
                        </div>
                        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-1">
                          <span className="font-medium">Credits Required:</span>
                          <Badge variant="outline" className="flex items-center gap-1">
                            <CreditCard className="h-3 w-3" />
                            {selectedTemplate.creditCost}
                          </Badge>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </>
            )}

            {/* Generate Button */}
            <Button
              type="submit"
              size="lg"
              className="w-full h-12 text-base font-semibold"
              disabled={isGenerating}
            >
              {isGenerating ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2" />
                  Generating Content...
                </>
              ) : form.watch("contentType") === "trade_rumor_mill" ? (
                <>
                  <Sparkles className="h-4 w-4 mr-2" />
                  Configure Trade Rumor
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4 mr-2" />
                  Generate Content
                </>
              )}
            </Button>
          </form>
        </Form>
      </CardContent>
      
      {/* Trade Rumor Dialog */}
      <TradeRumorDialog
        open={showTradeRumorDialog}
        onOpenChange={setShowTradeRumorDialog}
        leagueId={leagueId}
        currentTeamId={currentUserTeam?._id}
        onConfirm={handleTradeRumorConfirm}
      />
    </Card>
  );
}