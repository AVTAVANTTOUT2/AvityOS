import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = TestResizeObserver as typeof ResizeObserver;
HTMLElement.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 1024, 768);

afterEach(() => cleanup());
