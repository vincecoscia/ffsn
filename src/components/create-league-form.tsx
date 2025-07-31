"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";

export function CreateLeagueForm() {
  const router = useRouter();

  const handleCreateLeague = () => {
    router.push("/setup");
  };

  return (
    <Button
      onClick={handleCreateLeague}
      className="bg-red-600 hover:bg-red-700"
      size="lg"
    >
      <Plus className="h-5 w-5 mr-2" />
      Create New League
    </Button>
  );
}