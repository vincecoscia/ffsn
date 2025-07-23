"use client";

import { useRouter } from "next/navigation";

export function CreateLeagueForm() {
  const router = useRouter();

  const handleCreateLeague = () => {
    router.push("/setup");
  };

  return (
    <button
      onClick={handleCreateLeague}
      className="bg-red-600 text-white px-6 py-3 rounded-lg font-semibold hover:bg-red-700 transition-colors"
    >
      Create New League
    </button>
  );
}