import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function PolicyNotFound() {
  return (
    <div className="mx-auto max-w-md space-y-4">
      <h1 className="text-2xl font-semibold">Policy not found</h1>
      <p className="text-sm text-muted-foreground">
        That policy ID does not exist in the control plane store.
      </p>
      <Button variant="outline" asChild>
        <Link href="/">Back to Dashboard</Link>
      </Button>
    </div>
  );
}
