"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { Cpu, AlertCircle, CheckCircle2, Loader2 } from "lucide-react";

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
        return <div className="w-5 h-5 rounded-full border-2 border-gray-300" />;
      case "processing":
        return <Loader2 className="w-5 h-5 animate-spin text-red-600" />;
      case "completed":
        return <CheckCircle2 className="w-5 h-5 text-green-600" />;
      case "error":
        return <AlertCircle className="w-5 h-5 text-red-600" />;
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <div className="flex gap-3">
          <Cpu className="h-5 w-5 text-blue-600 flex-shrink-0 mt-0.5" />
          <div>
            <h4 className="text-sm font-medium text-blue-800">Data Processing</h4>
            <p className="text-sm text-blue-700 mt-1">
              Process league data to calculate advanced metrics for AI content generation. 
              This includes team strength analysis, rivalry detection, and manager activity tracking.
            </p>
          </div>
        </div>
      </div>

      {/* Processing Steps */}
      <div className="space-y-3">
        <label className="block text-sm font-medium text-gray-700">
          Processing Steps
        </label>
        <div className="bg-gray-50 rounded-lg p-4 space-y-3">
          {processingSteps.map((step) => (
            <div key={step.id} className="flex items-start gap-3">
              {getStepIcon(step.status)}
              <div className="flex-1">
                <div className="font-medium text-sm text-gray-900">{step.name}</div>
                <div className="text-xs text-gray-600">{step.description}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <button
        onClick={handleProcessData}
        disabled={isProcessing}
        className="w-full px-4 py-3 bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
      >
        {isProcessing ? (
          <>
            <Loader2 className="h-5 w-5 animate-spin" />
            Processing League Data...
          </>
        ) : (
          <>
            <Cpu className="h-5 w-5" />
            Run Data Processing
          </>
        )}
      </button>
      
      <p className="text-xs text-gray-500 text-center">
        This process analyzes your league data to generate insights for AI-powered content creation.
      </p>
    </div>
  );
}