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
    <Button onClick={handleCreateLeague} size="lg">
      <Plus className="size-5" strokeWidth={2} />
      Create new league
    </Button>
  );
}