"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { Cpu, AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface DataProcessingManagerProps {
  leagueId: Id<"leagues">;
}

interface ProcessingStep {
  id: string;
  name: string;
  description: string;
  status: "pending" | "processing" | "completed" | "error";
}

export function DataProcessingManager({ leagueId }: DataProcessingManagerProps) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingSteps, setProcessingSteps] = useState<ProcessingStep[]>([
    {
      id: "team-metrics",
      name: "Team Metrics",
      description: "Calculate strength of schedule and recent form",
      status: "pending"
    },
    {
      id: "rivalries",
      name: "Detect Rivalries",
      description: "Analyze matchup history to identify team rivalries",
      status: "pending"
    },
    {
      id: "manager-activity",
      name: "Manager Activity",
      description: "Track transactions, trades, and lineup changes",
      status: "pending"
    }
  ]);

  const processLeagueData = useMutation(api.dataProcessing.runDataProcessing);

  const updateStepStatus = (stepId: string, status: ProcessingStep["status"]) => {
    setProcessingSteps(prev =>
      prev.map(step =>
        step.id === stepId ? { ...step, status } : step
      )
    );
  };

  const handleProcessData = async () => {
    setIsProcessing(true);

    // Reset all steps to pending
    setProcessingSteps(prev =>
      prev.map(step => ({ ...step, status: "pending" }))
    );

    try {
      // Process team metrics
      updateStepStatus("team-metrics", "processing");
      await new Promise(resolve => setTimeout(resolve, 1000)); // Simulate processing

      // Process rivalries
      updateStepStatus("team-metrics", "completed");
      updateStepStatus("rivalries", "processing");
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Process manager activity
      updateStepStatus("rivalries", "completed");
      updateStepStatus("manager-activity", "processing");
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Run the actual data processing
      const result = await processLeagueData({
        leagueId,
        seasonId: new Date().getFullYear()
      });

      if (result.success) {
        updateStepStatus("manager-activity", "completed");
        toast.success("Data processing completed!", {
          description: "All league metrics have been calculated and stored."
        });
      } else {
        throw new Error("Data processing failed");
      }
    } catch (error) {
      // Mark current processing step as error
      const currentStep = processingSteps.find(step => step.status === "processing");
      if (currentStep) {
        updateStepStatus(currentStep.id, "error");
      }

      toast.error("Failed to process league data", {
        description: error instanceof Error ? error.message : "Please try again or contact support."
      });
      console.error("Data processing error:", error);
    } finally {
      setIsProcessing(false);
    }
  };

  const getStepIcon = (status: ProcessingStep["status"]) => {
    switch (status) {
      case "pending":
        return <div className="size-5 border-2 border-bc-border-strong" />;
      case "processing":
        return <Loader2 className="size-5 animate-spin text-bc-red-text" />;
      case "completed":
        return <CheckCircle2 className="size-5 text-bc-win" />;
      case "error":
        return <AlertCircle className="size-5 text-bc-red-text" />;
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3 border-l-4 border-l-bc-signal bg-bc-panel-2 p-4">
        <Cpu className="mt-0.5 size-5 flex-none text-bc-signal" />
        <div>
          <p className="font-display text-[15px] font-bold uppercase tracking-[0.02em] text-bc-ink">Data processing</p>
          <p className="mt-1 text-sm leading-relaxed text-bc-text-2">
            Process league data to calculate advanced metrics for AI content generation.
            This includes team strength analysis, rivalry detection, and manager activity tracking.
          </p>
        </div>
      </div>

      {/* Processing Steps */}
      <div className="flex flex-col gap-3">
        <span className="bc-label-sm text-bc-text-3">Processing steps</span>
        <div className="flex flex-col gap-3 border border-bc-hairline bg-bc-panel-2 p-4">
          {processingSteps.map((step) => (
            <div key={step.id} className="flex items-start gap-3">
              {getStepIcon(step.status)}
              <div className="flex-1">
                <div
                  className={cn(
                    "text-sm font-semibold",
                    step.status === "error" ? "text-bc-red-text" : "text-bc-ink"
                  )}
                >
                  {step.name}
                </div>
                <div className="text-xs text-bc-text-3">{step.description}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <Button onClick={handleProcessData} disabled={isProcessing} size="lg" className="w-full">
        <Loader2 className={cn("size-5", isProcessing ? "animate-spin" : "hidden")} />
        <Cpu className={cn("size-5", isProcessing ? "hidden" : "")} />
        {isProcessing ? "Processing league data" : "Run data processing"}
      </Button>

      <p className="text-center text-xs text-bc-text-3">
        This process analyzes your league data to generate insights for AI-powered content creation.
      </p>
    </div>
  );
}
