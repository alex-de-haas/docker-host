import { getCoreOrigin } from "../../shell/server-env";
import { OAuthConsentPage } from "./consent-client";

export const dynamic = "force-dynamic";

export default function ConsentRoute() {
  return <OAuthConsentPage coreOrigin={getCoreOrigin()} />;
}
