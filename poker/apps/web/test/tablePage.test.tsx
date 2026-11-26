import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCards, type BlindLevel } from "@poker/engine";
import type { GameSettings, SeatView } from "@poker/protocol";
import type { SeatActions } from "../src/table/sceneContext.js";
import type { TableState } from "../src/table/types.js";

const mocks = vi.hoisted(() => {
  class ApiError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    ApiError,
    api: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
    connectTable: vi.fn(),
    useDirector: vi.fn(),
    requestEquity: vi.fn(),
    me: {
      current: null as {
        id: string;
        email: string;
        displayName: string;
        avatarUrl: string;
      } | null,
    },
    seatActions: { current: null as SeatActions | null },
    store: { current: null as unknown },
    Cards: ({ fourColour }: { fourColour?: boolean }) => (
      <div
        data-testid="cards-mock"
        data-four-colour={String(fourColour === true)}
      />
    ),
  };
});

vi.mock("../src/api/client.js", () => ({
  api: mocks.api,
  ApiError: mocks.ApiError,
}));
vi.mock("../src/api/socket.js", () => ({
  getSocket: () => ({ emit: mocks.emit }),
}));
vi.mock("../src/api/useMe.js", () => ({
  useMe: () => ({
    me: mocks.me.current,
    loading: false,
    refresh: async () => {},
    setMe: () => {},
  }),
}));
vi.mock("../src/workers/useEquity.js", () => ({
  useEquity: () => mocks.requestEquity,
}));
vi.mock("../src/table/Table3D.js", async () => {
  const { Children, isValidElement } = await import("react");
  return {
    // jsdom has no WebGL: the canvas children are rendered nowhere (except the mocked <Cards>, so its props can
    // be checked), the overlay in a plain div.
    Table3D: ({
      children,
      overlay,
    }: {
      children?: ReactNode;
      overlay?: ReactNode;
    }) => (
      <div data-testid="table-3d">
        {Children.toArray(children).filter(
          (c) => isValidElement(c) && c.type === mocks.Cards,
        )}
        {overlay}
      </div>
    ),
  };
});
vi.mock("../src/table/Cards.js", () => ({ Cards: mocks.Cards }));
vi.mock("../src/table/useTableStore.js", async () => {
  const { createBareTableStore } = await import("../src/table/storeContext.js");
  const tableStore = createBareTableStore();
  mocks.store.current = tableStore;
  return {
    tableStore,
    createTableStore: createBareTableStore,
    useTableStore: () => {
      throw new Error("TablePage must read the store through the context");
    },
    connectTable: mocks.connectTable,
    useDirector: mocks.useDirector,
  };
});
vi.mock("../src/table/ActionBar.js", async () => {
  const { useSeatActions } = await import("../src/table/sceneContext.js");
  return {
    ActionBar: ({ gameId }: { gameId: string }) => {
      mocks.seatActions.current = useSeatActions();
      return <div data-testid="action-bar-mock" data-game-id={gameId} />;
    },
  };
});
vi.mock("../src/table/ChatPanel.js", () => ({
  ChatPanel: () => <div data-testid="chat-mock" />,
}));
vi.mock("../src/table/NotesPopover.js", () => ({
  NotesPopover: ({ subjectId, name }: { subjectId: string; name: string }) => (
    <div data-testid="notes-mock">
      {subjectId}:{name}
    </div>
  ),
}));
vi.mock("../src/pages/HostPanel.js", () => ({
  HostPanel: ({ gameId }: { gameId: string }) => <p>Host tools {gameId}</p>,
}));

import type { StoreApi } from "zustand";
import { initialTableState } from "../src/table/types.js";
import {
  FOUR_COLOUR_KEY,
  formatCountdown,
  TablePage,
} from "../src/pages/TablePage.js";

const store = (): StoreApi<TableState> =>
  mocks.store.current as StoreApi<TableState>;

const GAME_ID = "11111111-1111-4111-8111-111111111111";
const HOST_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CARA_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const level1: BlindLevel = {
  level: 1,
  smallBlind: 5,
  bigBlind: 10,
  ante: 0,
  anteKind: "none",
  durationMinutes: 15,
};

function cashSettings(over: Partial<GameSettings> = {}): GameSettings {
  return {
    kind: "cash",
    maxSeats: 6,
    levels: [level1],
    minBuyIn: 200,
    maxBuyIn: 1000,
    startingStack: 0,
    turnSeconds: 20,
    timeBankSeconds: 60,
    timeBankTopUpSeconds: 10,
    rebuys: { allowed: false, untilLevel: 0 },
    payouts: [100],
    seatApproval: false,
    autoStart: false,
    showAllInEquity: true,
    ...over,
  };
}

function seat(
  n: number,
  playerId: string,
  name: string,
  over: Partial<SeatView> = {},
): SeatView {
  return {
    seat: n,
    playerId,
    name,
    avatarUrl: null,
    stack: 500,
    bet: 0,
    folded: false,
    allIn: false,
    sittingOut: false,
    connected: true,
    cardsVisible: null,
    hasCards: false,
    ...over,
  };
}

function setTable(patch: Partial<TableState>): void {
  act(() => store().setState(patch));
}

function game(hostId = HOST_ID) {
  return {
    id: GAME_ID,
    name: "Friday Night",
    startsAt: "2026-12-01T19:00:00.000Z",
    status: "open",
    settings: cashSettings(),
    host: { id: hostId, displayName: "Hank", avatarUrl: "" },
    invites: [],
    myRsvp: null,
    isHost: hostId === HOST_ID,
  };
}

let wallet = 5000;

function routeApi(path: string): Promise<unknown> {
  if (path === `/api/games/${GAME_ID}`) return Promise.resolve(game());
  if (path === "/api/wallet")
    return Promise.resolve({ balance: wallet, entries: [] });
  return Promise.reject(new mocks.ApiError(404, "Not found"));
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/table/${GAME_ID}`]}>
      <Routes>
        <Route path="/table/:id" element={<TablePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function renderLoaded() {
  const r = renderPage();
  expect(
    await screen.findByRole("heading", { level: 1, name: "Friday Night" }),
  ).toBeInTheDocument();
  return r;
}

function emitted(event: string): unknown[] {
  return mocks.emit.mock.calls.filter((c) => c[0] === event).map((c) => c[1]);
}

beforeEach(() => {
  wallet = 5000;
  localStorage.clear();
  mocks.api.mockReset();
  mocks.api.mockImplementation(routeApi);
  mocks.emit.mockReset();
  mocks.disconnect.mockReset();
  mocks.connectTable.mockReset();
  mocks.connectTable.mockReturnValue(mocks.disconnect);
  mocks.useDirector.mockReset();
  mocks.requestEquity.mockReset();
  mocks.me.current = {
    id: HOST_ID,
    email: "h@example.com",
    displayName: "Hank",
    avatarUrl: "",
  };
  mocks.seatActions.current = null;
  store().setState(
    { ...initialTableState(), settings: cashSettings(), gameId: GAME_ID },
    false,
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("TablePage", () => {
  it("connects on mount, mounts the director, and disconnects on unmount", async () => {
    const { unmount } = await renderLoaded();
    expect(mocks.connectTable).toHaveBeenCalledTimes(1);
    expect(mocks.connectTable).toHaveBeenCalledWith(GAME_ID, store(), HOST_ID);
    expect(mocks.useDirector).toHaveBeenCalled();
    expect(screen.getByText("Play money")).toBeInTheDocument();
    expect(screen.getByTestId("action-bar-mock")).toHaveAttribute(
      "data-game-id",
      GAME_ID,
    );
    expect(mocks.disconnect).not.toHaveBeenCalled();
    unmount();
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
  });

  it("shows the access message on a 403", async () => {
    mocks.api.mockRejectedValue(new mocks.ApiError(403, "Forbidden"));
    renderPage();
    expect((await screen.findByRole("alert")).textContent).toBe(
      "You don't have access to this game",
    );
  });

  it("shows the status banner texts and the stakes", async () => {
    await renderLoaded();
    const banner = screen.getByTestId("table-status");
    expect(banner).toHaveTextContent("Waiting for players");
    expect(screen.getByText("$5/$10")).toBeInTheDocument();
    setTable({ status: "paused" });
    expect(banner).toHaveTextContent("Paused");
    setTable({ status: "finished" });
    expect(banner).toHaveTextContent("Game over");
  });

  it("ticks the tournament countdown every second", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date("2026-11-26T12:00:00Z"));
    const level3: BlindLevel = {
      ...level1,
      level: 3,
      smallBlind: 25,
      bigBlind: 50,
    };
    store().setState({
      settings: cashSettings({
        kind: "tournament",
        levels: [level1, level3],
        startingStack: 1500,
      }),
      status: "running",
      level: level3,
      nextLevelAt: Date.now() + 252_000,
    });
    renderPage();
    await act(async () => {});
    const banner = screen.getByTestId("table-status");
    expect(banner).toHaveTextContent("Level 3 · next level in 04:12");
    expect(screen.getByText("$25/$50")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1000));
    expect(banner).toHaveTextContent("Level 3 · next level in 04:11");
    act(() => vi.advanceTimersByTime(60_000));
    expect(banner).toHaveTextContent("Level 3 · next level in 03:11");
  });

  it("formats countdowns", () => {
    expect(formatCountdown(252_000)).toBe("04:12");
    expect(formatCountdown(251_001)).toBe("04:12");
    expect(formatCountdown(-5)).toBe("00:00");
  });

  it('shows "Start game" only to the host in waiting with at least 2 seated, and sends start', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    expect(screen.queryByRole("button", { name: "Start game" })).toBeNull();
    setTable({ seats: [seat(0, HOST_ID, "Hank")] });
    expect(screen.queryByRole("button", { name: "Start game" })).toBeNull();
    setTable({ seats: [seat(0, HOST_ID, "Hank"), seat(3, BOB_ID, "Bob")] });
    await user.click(screen.getByRole("button", { name: "Start game" }));
    expect(emitted("host:command")).toEqual([
      { gameId: GAME_ID, command: { kind: "start" } },
    ]);
    setTable({ status: "running" });
    expect(screen.queryByRole("button", { name: "Start game" })).toBeNull();
  });

  it("hides host controls from other players", async () => {
    mocks.me.current = {
      id: BOB_ID,
      email: "b@example.com",
      displayName: "Bob",
      avatarUrl: "",
    };
    store().setState({
      seats: [seat(0, HOST_ID, "Hank"), seat(3, BOB_ID, "Bob")],
    });
    await renderLoaded();
    expect(screen.queryByRole("button", { name: "Start game" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Host panel" })).toBeNull();
    expect(screen.queryByTestId("host-panel")).toBeNull();
  });

  it("opens the sit dialog with the buy-in bounded by the wallet and sends table:sit", async () => {
    const user = userEvent.setup();
    wallet = 700;
    await renderLoaded();
    act(() => mocks.seatActions.current?.onSit(2));
    const dialog = screen.getByRole("dialog", { name: "Sit down" });
    const field = await within(dialog).findByLabelText("Buy-in");
    expect(field).toHaveAttribute("min", "200");
    expect(field).toHaveAttribute("max", "700");
    await waitFor(() => expect(field).toHaveValue(700));
    const sit = within(dialog).getByRole("button", { name: "Sit down" });
    fireEvent.change(field, { target: { value: "900" } });
    expect(sit).toBeDisabled();
    fireEvent.change(field, { target: { value: "150" } });
    expect(sit).toBeDisabled();
    fireEvent.change(field, { target: { value: "450" } });
    expect(sit).toBeEnabled();
    await user.click(sit);
    const [payload] = emitted("table:sit") as {
      gameId: string;
      seat: number;
      buyIn: number;
      clientSeed: string;
    }[];
    expect(payload).toMatchObject({ gameId: GAME_ID, seat: 2, buyIn: 450 });
    expect(payload?.clientSeed).toMatch(/^[0-9a-f]{32}$/);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("uses maxBuyIn as the default when the wallet is larger, and Cancel/Escape close", async () => {
    const user = userEvent.setup();
    await renderLoaded();
    act(() => mocks.seatActions.current?.onSit(0));
    const field = await screen.findByLabelText("Buy-in");
    expect(field).toHaveAttribute("max", "1000");
    await waitFor(() => expect(field).toHaveValue(1000));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => mocks.seatActions.current?.onSit(0));
    await screen.findByLabelText("Buy-in");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(emitted("table:sit")).toEqual([]);
  });

  it("explains a too-small wallet and disables the button", async () => {
    wallet = 100;
    await renderLoaded();
    act(() => mocks.seatActions.current?.onSit(1));
    const dialog = screen.getByRole("dialog", { name: "Sit down" });
    expect(
      await within(dialog).findByText(/minimum buy-in is \$200/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Sit down" }),
    ).toBeDisabled();
    expect(within(dialog).queryByLabelText("Buy-in")).toBeNull();
  });

  it("shows the fixed starting stack for a tournament", async () => {
    const user = userEvent.setup();
    store().setState({
      settings: cashSettings({ kind: "tournament", startingStack: 1500 }),
    });
    await renderLoaded();
    act(() => mocks.seatActions.current?.onSit(4));
    const dialog = screen.getByRole("dialog", { name: "Sit down" });
    expect(within(dialog).getByText("$1,500")).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Buy-in")).toBeNull();
    const sit = within(dialog).getByRole("button", { name: "Sit down" });
    await waitFor(() => expect(sit).toBeEnabled());
    await user.click(sit);
    expect(emitted("table:sit")).toEqual([
      {
        gameId: GAME_ID,
        seat: 4,
        buyIn: 1500,
        clientSeed: expect.stringMatching(/^[0-9a-f]{32}$/),
      },
    ]);
  });

  it("asks before leaving and sends table:leave", async () => {
    const user = userEvent.setup();
    await renderLoaded();
    expect(screen.queryByRole("button", { name: "Leave table" })).toBeNull();
    setTable({ seats: [seat(1, HOST_ID, "Hank")], mySeat: 1 });
    await user.click(screen.getByRole("button", { name: "Leave table" }));
    expect(emitted("table:leave")).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Stay" }));
    expect(emitted("table:leave")).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Leave table" }));
    const confirm = screen.getByRole("group", { name: "Leave table?" });
    await user.click(
      within(confirm).getByRole("button", { name: "Leave now" }),
    );
    expect(emitted("table:leave")).toEqual([{ gameId: GAME_ID }]);
  });

  it("offers a rebuy in a tournament when I am busted and rebuys are allowed", async () => {
    const user = userEvent.setup();
    store().setState({
      settings: cashSettings({
        kind: "tournament",
        startingStack: 1500,
        rebuys: { allowed: true, untilLevel: 2 },
      }),
      seats: [seat(1, HOST_ID, "Hank", { stack: 0 })],
      mySeat: 1,
      level: level1,
    });
    await renderLoaded();
    await user.click(screen.getByRole("button", { name: "Rebuy" }));
    expect(emitted("table:rebuy")).toEqual([{ gameId: GAME_ID }]);
    setTable({ level: { ...level1, level: 3 } });
    expect(screen.queryByRole("button", { name: "Rebuy" })).toBeNull();
  });

  it("toggles the host panel slide-over", async () => {
    const user = userEvent.setup();
    await renderLoaded();
    const panel = screen.getByTestId("host-panel");
    expect(panel).toHaveAttribute("data-open", "false");
    expect(panel).toHaveAttribute("aria-hidden", "true");
    expect(panel.hasAttribute("inert")).toBe(true);
    expect(panel.style.transform).toBe("translateX(100%)");
    expect(
      within(panel).getByText(`Host tools ${GAME_ID}`),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Host panel" }));
    expect(panel).toHaveAttribute("data-open", "true");
    expect(panel.hasAttribute("inert")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Host panel" }));
    expect(panel).toHaveAttribute("data-open", "false");
  });

  it("renders the board as text spans", async () => {
    await renderLoaded();
    expect(
      screen.getByTestId("board").querySelectorAll("span[data-card]"),
    ).toHaveLength(0);
    setTable({ board: parseCards("As Kd 7h") });
    const spans = [
      ...screen.getByTestId("board").querySelectorAll("span[data-card]"),
    ];
    expect(spans.map((s) => s.getAttribute("data-card"))).toEqual([
      "As",
      "Kd",
      "7h",
    ]);
    expect(spans.every((s) => s.classList.contains("sr-only"))).toBe(true);
  });

  it("renders the hand log, newest at the bottom, with tones", async () => {
    await renderLoaded();
    setTable({
      handLog: [
        { id: 1, text: "Hand #1", tone: "info" },
        { id: 2, text: "Bob wins $40", tone: "good" },
        { id: 3, text: "Card check failed", tone: "bad" },
      ],
    });
    const items = within(screen.getByTestId("hand-log")).getAllByRole(
      "listitem",
    );
    expect(items.map((i) => i.textContent)).toEqual([
      "Hand #1",
      "Bob wins $40",
      "Card check failed",
    ]);
    expect(items[1]).toHaveClass("table-log-good");
    expect(items[2]).toHaveClass("table-log-bad");
  });

  it("shows the last error in a dismissible alert", async () => {
    const user = userEvent.setup();
    store().setState({ setError: (e) => store().setState({ lastError: e }) });
    await renderLoaded();
    setTable({ lastError: "Not your turn" });
    expect(screen.getByRole("alert")).toHaveTextContent("Not your turn");
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("requests equity on state changes and clears it after I fold", async () => {
    store().setState({
      seats: [
        seat(0, HOST_ID, "Hank"),
        seat(2, BOB_ID, "Bob"),
        seat(4, CARA_ID, "Cara"),
      ],
      mySeat: 0,
    });
    await renderLoaded();
    expect(mocks.requestEquity).toHaveBeenLastCalledWith(null);

    const hole = parseCards("As Ah");
    setTable({
      myHole: hole,
      seats: [
        seat(0, HOST_ID, "Hank", { hasCards: true }),
        seat(2, BOB_ID, "Bob", { hasCards: true }),
        seat(4, CARA_ID, "Cara", { hasCards: true }),
      ],
    });
    expect(mocks.requestEquity).toHaveBeenLastCalledWith({
      hole,
      board: [],
      opponents: 2,
    });

    setTable({
      seats: [
        seat(0, HOST_ID, "Hank", { hasCards: true }),
        seat(2, BOB_ID, "Bob", { hasCards: true, folded: true }),
        seat(4, CARA_ID, "Cara", { hasCards: true }),
      ],
    });
    expect(mocks.requestEquity).toHaveBeenLastCalledWith({
      hole,
      board: [],
      opponents: 1,
    });

    const flop = parseCards("Kd 7h 2c");
    setTable({ board: flop });
    expect(mocks.requestEquity).toHaveBeenLastCalledWith({
      hole,
      board: flop,
      opponents: 1,
    });

    const calls = mocks.requestEquity.mock.calls.length;
    setTable({ handLog: [{ id: 1, text: "noise", tone: "info" }] });
    expect(mocks.requestEquity.mock.calls.length).toBe(calls);

    setTable({
      seats: [
        seat(0, HOST_ID, "Hank", { hasCards: true, folded: true }),
        seat(2, BOB_ID, "Bob", { hasCards: true, folded: true }),
        seat(4, CARA_ID, "Cara", { hasCards: true }),
      ],
    });
    expect(mocks.requestEquity).toHaveBeenLastCalledWith(null);
  });

  it("lets the host approve or decline seat requests", async () => {
    const user = userEvent.setup();
    store().setState({
      seatRequests: [
        { playerId: BOB_ID, name: "Bob" },
        { playerId: CARA_ID, name: "Cara" },
      ],
    });
    await renderLoaded();
    expect(screen.getByText("Bob wants to sit")).toBeInTheDocument();
    const [approveBob] = screen.getAllByRole("button", { name: "Approve" });
    const [, declineCara] = screen.getAllByRole("button", { name: "Decline" });
    await user.click(approveBob!);
    await user.click(declineCara!);
    expect(emitted("host:command")).toEqual([
      {
        gameId: GAME_ID,
        command: { kind: "approveSeat", playerId: BOB_ID, approve: true },
      },
      {
        gameId: GAME_ID,
        command: { kind: "approveSeat", playerId: CARA_ID, approve: false },
      },
    ]);
  });

  it("opens the notes popover from the seat actions", async () => {
    await renderLoaded();
    act(() => mocks.seatActions.current?.onOpenNotes(BOB_ID, "Bob"));
    expect(screen.getByTestId("notes-mock")).toHaveTextContent(`${BOB_ID}:Bob`);
  });

  it("shows the game-over panel with results and links", async () => {
    store().setState({
      status: "finished",
      results: [
        { userId: BOB_ID, name: "Bob", place: 2, prize: 300 },
        { userId: HOST_ID, name: "Hank", place: 1, prize: 1200 },
      ],
    });
    await renderLoaded();
    const panel = screen.getByRole("region", { name: "Game over" });
    const rows = within(panel)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(rows).toEqual(["1.Hank$1,200", "2.Bob$300"]);
    expect(
      within(panel).getByRole("link", { name: "Results" }),
    ).toHaveAttribute("href", `/results/${GAME_ID}`);
    expect(
      within(panel).getByRole("link", { name: "Settle up" }),
    ).toHaveAttribute("href", `/settle/${GAME_ID}`);
    expect(
      within(panel).getByRole("link", { name: "Back to game" }),
    ).toHaveAttribute("href", `/games/${GAME_ID}`);
  });

  it("has a four-colour deck option, off by default, remembered in localStorage", async () => {
    const user = userEvent.setup();
    const { unmount } = await renderLoaded();
    const box = screen.getByRole("checkbox", { name: "Four-colour deck" });
    expect(box).not.toBeChecked();
    expect(screen.getByTestId("cards-mock")).toHaveAttribute(
      "data-four-colour",
      "false",
    );
    await user.click(box);
    expect(box).toBeChecked();
    expect(screen.getByTestId("cards-mock")).toHaveAttribute(
      "data-four-colour",
      "true",
    );
    expect(localStorage.getItem(FOUR_COLOUR_KEY)).toBe("1");
    unmount();

    await renderLoaded();
    expect(
      screen.getByRole("checkbox", { name: "Four-colour deck" }),
    ).toBeChecked();
    expect(screen.getByTestId("cards-mock")).toHaveAttribute(
      "data-four-colour",
      "true",
    );
    await user.click(
      screen.getByRole("checkbox", { name: "Four-colour deck" }),
    );
    expect(localStorage.getItem(FOUR_COLOUR_KEY)).toBe("0");
  });

  it("reads a stored four-colour choice on mount and survives blocked storage", async () => {
    localStorage.setItem(FOUR_COLOUR_KEY, "1");
    const { unmount } = await renderLoaded();
    expect(
      screen.getByRole("checkbox", { name: "Four-colour deck" }),
    ).toBeChecked();
    unmount();

    const user = userEvent.setup();
    const get = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    const set = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    try {
      await renderLoaded();
      const box = screen.getByRole("checkbox", { name: "Four-colour deck" });
      expect(box).not.toBeChecked();
      await user.click(box);
      expect(box).toBeChecked();
      expect(screen.getByTestId("cards-mock")).toHaveAttribute(
        "data-four-colour",
        "true",
      );
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });
});
