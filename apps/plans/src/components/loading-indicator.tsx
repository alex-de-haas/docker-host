import { Spinner } from "@/components/ui/spinner";

export function LoadingIndicator({ message }: { message: string }) {
  return <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner aria-hidden="true" /><span>{message}</span></div>;
}
