"use client";

import { useState, useEffect } from "react";
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
import { Sparkles, Zap, Clock, CreditCard } from "lucide-react";

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
});

export function ContentGenerator({ leagueId, isCommissioner }: ContentGeneratorProps) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [selectedSeason, setSelectedSeason] = useState<number | null>(null);
  const [selectedWeek, setSelectedWeek] = useState<number | null>(null);

  const createGenerationRequest = useMutation(api.aiContent.createGenerationRequest);
  const completedWeeks = useQuery(api.matchups.getCompletedWeeks, { leagueId });

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      contentType: "",
      persona: "",
      seasonId: undefined,
      week: undefined,
      customContext: "",
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
    } else if (contentType !== "weekly_recap") {
      // Clear season/week for other content types
      setSelectedSeason(null);
      setSelectedWeek(null);
      form.setValue("seasonId", undefined);
      form.setValue("week", undefined);
    }
  }, [contentType, completedWeeks, form]);

  const handleGenerate = async (values: z.infer<typeof formSchema>) => {
    setIsGenerating(true);
    try {
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

      // Reset form
      form.reset();
    } catch (error) {
      toast.error("Failed to generate content", {
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
          <CardTitle className="text-2xl font-bold">AI Content Generator</CardTitle>
        </div>
        <CardDescription>
          Generate engaging fantasy football content with AI-powered personas
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-8">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleGenerate)} className="space-y-8">
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
                      <SelectTrigger className="h-12">
                        <SelectValue placeholder="Choose what type of content to generate..." />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectGroup>
                        <SelectLabel>Weekly Content</SelectLabel>
                        <SelectItem value="weekly_recap">
                          <div className="flex items-center justify-between w-full">
                            <span>Weekly Recap</span>
                            <Badge variant="secondary" className="ml-2">10 credits</Badge>
                          </div>
                        </SelectItem>
                        <SelectItem value="weekly_preview">
                          <div className="flex items-center justify-between w-full">
                            <span>Weekly Preview</span>
                            <Badge variant="secondary" className="ml-2">10 credits</Badge>
                          </div>
                        </SelectItem>
                        <SelectItem value="power_rankings">
                          <div className="flex items-center justify-between w-full">
                            <span>Power Rankings</span>
                            <Badge variant="secondary" className="ml-2">8 credits</Badge>
                          </div>
                        </SelectItem>
                        <SelectItem value="waiver_wire_report">
                          <div className="flex items-center justify-between w-full">
                            <span>Waiver Wire Report</span>
                            <Badge variant="secondary" className="ml-2">12 credits</Badge>
                          </div>
                        </SelectItem>
                        <SelectItem value="mock_draft">
                          <div className="flex items-center justify-between w-full">
                            <span>Mock Draft</span>
                            <Badge variant="secondary" className="ml-2">15 credits</Badge>
                          </div>
                        </SelectItem>
                      </SelectGroup>
                      
                      <SelectGroup>
                        <SelectLabel>Special Content</SelectLabel>
                        <SelectItem value="trade_analysis">
                          <div className="flex items-center justify-between w-full">
                            <span>Trade Analysis</span>
                            <Badge variant="secondary" className="ml-2">5 credits</Badge>
                          </div>
                        </SelectItem>
                        <SelectItem value="rivalry_week_special">
                          <div className="flex items-center justify-between w-full">
                            <span>Rivalry Week Special</span>
                            <Badge variant="secondary" className="ml-2">10 credits</Badge>
                          </div>
                        </SelectItem>
                        <SelectItem value="emergency_hot_takes">
                          <div className="flex items-center justify-between w-full">
                            <span>Emergency Hot Takes</span>
                            <Badge variant="secondary" className="ml-2">5 credits</Badge>
                          </div>
                        </SelectItem>
                      </SelectGroup>
                      
                      <SelectGroup>
                        <SelectLabel>Season Content</SelectLabel>
                        <SelectItem value="mid_season_awards">
                          <div className="flex items-center justify-between w-full">
                            <span>Mid-Season Awards</span>
                            <Badge variant="secondary" className="ml-2">12 credits</Badge>
                          </div>
                        </SelectItem>
                        <SelectItem value="championship_manifesto">
                          <div className="flex items-center justify-between w-full">
                            <span>Championship Manifesto</span>
                            <Badge variant="secondary" className="ml-2">10 credits</Badge>
                          </div>
                        </SelectItem>
                        <SelectItem value="season_recap">
                          <div className="flex items-center justify-between w-full">
                            <span>Season Recap</span>
                            <Badge variant="secondary" className="ml-2">20 credits</Badge>
                          </div>
                        </SelectItem>
                      </SelectGroup>
                      
                      {isCommissioner && (
                        <SelectGroup>
                          <SelectLabel>Premium Content</SelectLabel>
                          <SelectItem value="custom_roast">
                            <div className="flex items-center justify-between w-full">
                              <span>Custom Roast</span>
                              <Badge variant="destructive" className="ml-2">25 credits</Badge>
                            </div>
                          </SelectItem>
                          <SelectItem value="season_welcome">
                            <div className="flex items-center justify-between w-full">
                              <span>Season Welcome Package</span>
                              <Badge variant="destructive" className="ml-2">30 credits</Badge>
                            </div>
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

            {/* Season/Week Selection for Weekly Recap */}
            {selectedContentType === "weekly_recap" && completedWeeks && (
              <div className="space-y-4">
                <FormField
                  control={form.control}
                  name="seasonId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-base font-semibold">Season</FormLabel>
                      <FormControl>
                        <SeasonSelector
                          currentSeason={completedWeeks[0]?.seasonId || new Date().getFullYear()}
                          selectedSeason={field.value || completedWeeks[0]?.seasonId || new Date().getFullYear()}
                          onSeasonChange={(season) => {
                            field.onChange(season);
                            setSelectedSeason(season);
                            // Reset week when season changes
                            const seasonData = completedWeeks.find(s => s.seasonId === season);
                            if (seasonData && seasonData.weeks.length > 0) {
                              const defaultWeek = seasonData.weeks[seasonData.weeks.length - 1];
                              setSelectedWeek(defaultWeek);
                              form.setValue("week", defaultWeek);
                            }
                          }}
                          availableSeasons={completedWeeks.map(s => s.seasonId)}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

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
                            .find(s => s.seasonId === selectedSeason)
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
                            className="flex items-start gap-3 p-4 rounded-lg border-2 cursor-pointer transition-all hover:bg-accent peer-data-[state=checked]:border-primary peer-data-[state=checked]:bg-primary/5 w-full"
                          >
                            <span className="text-2xl">{persona.icon}</span>
                            <div className="flex-1 text-left">
                              <div className="font-semibold">{persona.name}</div>
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
                        <div className="flex justify-between items-center">
                          <span className="font-medium">Content Type:</span>
                          <span className="text-sm">{selectedTemplate.name}</span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="font-medium">Persona:</span>
                          <span className="text-sm">{personas.find(p => p.id === selectedPersona)?.name}</span>
                        </div>
                        {selectedContentType === "weekly_recap" && selectedSeason && selectedWeek && (
                          <div className="flex justify-between items-center">
                            <span className="font-medium">Period:</span>
                            <span className="text-sm">{selectedSeason} - Week {selectedWeek}</span>
                          </div>
                        )}
                      </div>
                      <div className="space-y-2">
                        <div className="flex justify-between items-center">
                          <span className="font-medium">Estimated Length:</span>
                          <span className="text-sm">~{selectedTemplate.estimatedWords} words</span>
                        </div>
                        <div className="flex justify-between items-center">
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
    </Card>
  );
}