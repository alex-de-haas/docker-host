// @vitest-environment jsdom
import { act } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InputGroup, InputGroupAddon, InputGroupTextarea } from "./input-group";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
});

it("focuses the textarea, composes custom clicks, and respects cancellation and interactive children", async () => {
  const onClick = vi.fn();
  const render = async () => act(async () => root.render(<InputGroup>
    <input hidden type="file" />
    <InputGroupTextarea aria-label="Message" />
    <InputGroupAddon onClick={onClick}><span>Actions</span><button type="button">Attach</button></InputGroupAddon>
  </InputGroup>));
  await render();
  const textarea = container.querySelector("textarea")!;
  const caption = container.querySelector("span")!;
  const button = container.querySelector("button")!;
  await act(async () => caption.click());
  expect(onClick).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(textarea);
  button.focus();
  await act(async () => button.click());
  expect(document.activeElement).toBe(button);
  onClick.mockImplementation(event => event.preventDefault());
  await act(async () => caption.click());
  expect(document.activeElement).toBe(button);
});

it("does not take focus from content portaled out of the addon", async () => {
  await act(async () => root.render(<InputGroup>
    <InputGroupTextarea />
    <InputGroupAddon>{createPortal(<div data-testid="popover"><input aria-label="Search" /><span>Apps</span></div>, document.body)}</InputGroupAddon>
  </InputGroup>));
  const popover = document.querySelector('[data-testid="popover"]')!;
  const input = popover.querySelector("input")!;
  input.focus();
  await act(async () => popover.querySelector("span")!.click());
  expect(document.activeElement).toBe(input);
});
