import { CoreRequestError } from "../core-api";
import { Button } from "@/components/ui/button";

export function isSourcePermissionError(error: unknown) {
  return error instanceof CoreRequestError && error.code === "app_permission_required";
}

export function SourcePermissionHelp({ coreOrigin }: { coreOrigin: string }) {
  return <div className="space-y-2 text-sm text-muted-foreground">
    <p>Shell needs permission to manage your source accounts. Review “Personal source accounts and Git identity” in Core, then refresh this page.</p>
    <Button asChild variant="outline" size="sm"><a href={`${coreOrigin}/install/permissions/hosty.shell`} target="_blank" rel="noopener noreferrer">Review Shell permissions</a></Button>
  </div>;
}
