import { it,expect } from "vitest";
import { profileConfig } from "./store.js";
it("preserves opaque model IDs selected from a provider catalog",()=>{const model="qwen3.5:4b";expect(profileConfig({name:"Local",description:"",instructions:"",connectionId:null,model,reasoningEffort:"false",skillIds:[]})).toMatchObject({model});});
