import { NextResponse } from "next/server";
import { z } from "zod";
import { consumeOwnerApprovalLink } from "@/lib/owner-communication";

export const runtime = "nodejs";

const detailsSchema = z.record(
  z.string().max(120),
  z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()]),
).refine((value) => Object.keys(value).length <= 100);

function redirect(request: Request, status: string) {
  const url = new URL("/owner/approval/complete", request.url);
  url.searchParams.set("status", status);
  return NextResponse.redirect(url, 303);
}

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "The approval form is invalid." }, { status: 400 });
  }
  const token = form.get("token");
  const action = form.get("action");
  if (typeof token !== "string" || (action !== "approve" && action !== "edit")) {
    return NextResponse.json({ error: "The approval link is invalid." }, { status: 400 });
  }

  try {
    if (action === "approve") {
      if (form.get("decision") !== "approved") {
        return NextResponse.json({ error: "The approval decision is invalid." }, { status: 400 });
      }
      const status = await consumeOwnerApprovalLink({ token, action });
      if (status !== "updated") return redirect(request, status);
      return redirect(request, "approved");
    }

    const summary = form.get("summary");
    const rawDetails = form.get("details");
    if (typeof summary !== "string" || typeof rawDetails !== "string") {
      return NextResponse.json({ error: "Enter a summary and approval details." }, { status: 400 });
    }
    let detailsValue: unknown;
    try {
      detailsValue = JSON.parse(rawDetails);
    } catch {
      return NextResponse.json({ error: "Approval details must be valid JSON." }, { status: 400 });
    }
    const details = detailsSchema.safeParse(detailsValue);
    if (!details.success) {
      return NextResponse.json({ error: "Approval details contain unsupported values." }, { status: 400 });
    }
    const status = await consumeOwnerApprovalLink({
      token,
      action,
      summary: summary.trim(),
      details: details.data,
    });
    return redirect(request, status === "updated" ? "edited" : status);
  } catch (error) {
    console.error("Could not process an owner approval link:", error instanceof Error ? error.message : "Unknown error");
    return NextResponse.json({ error: "The approval link could not be processed. Check the approval inbox." }, { status: 500 });
  }
}
