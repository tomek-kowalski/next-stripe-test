import { describe, expect, it } from "vitest";
import { addDays, bookingDatesError, localIsoDay, resolveBookingDates } from "@/app/_components/booking-dates";
import { BookingSchema } from "@/lib/lab/schemas";

const today = new Date(2026, 9, 23, 23, 30); // 23 Oct 2026, 23:30 local time

describe("booking dates", () => {
  it("uses the local calendar day, not UTC", () => {
    expect(localIsoDay(today)).toBe("2026-10-23");
  });

  it("adds days across month ends", () => {
    expect(addDays("2026-10-30", 3)).toBe("2026-11-02");
  });

  it("defaults the end to 3 days after the chosen start, never before it", () => {
    // The reported bug: a start more than 3 days ahead with an empty end produced end < start.
    expect(resolveBookingDates("2026-11-10", "", today)).toEqual({ start: "2026-11-10", end: "2026-11-13" });
    expect(resolveBookingDates("", "", today)).toEqual({ start: "2026-10-23", end: "2026-10-26" });
    expect(resolveBookingDates("2026-11-10", "2026-11-11", today)).toEqual({ start: "2026-11-10", end: "2026-11-11" });
  });

  it("every resolved default passes the server-side booking schema", () => {
    for (const start of ["", "2026-10-23", "2026-12-30", "2027-02-27"]) {
      const dates = resolveBookingDates(start, "", today);
      const parsed = BookingSchema.safeParse({ id: "bk_0123456789ab", scenario: "A", item: "x", customer: "y", ...dates });
      expect(parsed.success, JSON.stringify(dates)).toBe(true);
    }
  });

  it("flags an end before the start, in Polish", () => {
    expect(bookingDatesError("2026-11-10", "2026-11-09")).toMatch(/wcześniejsza/);
    expect(bookingDatesError("2026-11-10", "2026-11-10")).toBeNull();
    expect(bookingDatesError("", "2026-11-09")).toBeNull();
  });
});
