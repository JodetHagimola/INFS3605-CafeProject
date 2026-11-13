import "server-only";
import { inventoryClient } from "@/lib/inventory/server";
import { tailorSupplierDraft } from "@/lib/inventory-deliveries/followups";
import { supplierDraft, type ShortageRow } from "@/lib/inventory-deliveries/shortage-email";

type Payload = { from: string; to: string; subject: string; text: string };
type Job = { event_id: string; status: string; channel: "inbox" | "resend" | null; payload: Payload | null; started_at: string | null;
  facts: { receipt: string; kind: "short" | "extra"; reference: string; ingredient: string; ordered: string; received: string; difference: string; unit: string; supplier: string | null } };

async function compose(job: Job) {
  const f = job.facts;
  if (f.kind === "short") {
    try { await tailorSupplierDraft(f.receipt); } catch { /* The saved standard wording is ready to use. */ }
    const { data,error } = await inventoryClient().from("delivery_shortage_drafts").select("receipt_id,approach,facts")
      .eq("receipt_id",f.receipt).single<ShortageRow>();
    if (error || !data) throw new Error("Could not read saved shortage.");
    const draft = supplierDraft({...data,facts:{...data.facts,reference:f.reference}});
    return {subject:draft.subject,text:draft.body};
  }
  return {subject:`Extra goods received for ${f.reference}`,text:
    `Hello,\n\nWe ordered ${f.ordered} ${f.unit} of ${f.ingredient} and received ${f.received} ${f.unit} in total. Please check the extra ${f.difference} ${f.unit} against your dispatch record and advise.\n\nThank you.`};
}

export async function deliverTestMail(eventId: string) {
  const db = inventoryClient();
  const jobs = () => db.from("cafe_test_mail");
  const loaded = await jobs().select("*").eq("event_id",eventId).single<Job>();
  if (loaded.error || !loaded.data) throw new Error("Email queue unavailable.");
  let job = loaded.data;
  if (job.status !== "queued") return job.status;
  try {
    if (!job.payload) {
      const channel = process.env.CAFE_MAIL_MODE || "inbox";
      if (channel !== "inbox" && channel !== "resend") throw new Error("Invalid test mail mode.");
      const to = channel === "inbox" ? "supplier@test.invalid" : process.env.CAFE_TEST_MAIL_TO?.trim();
      const from = channel === "inbox" ? "cafe@test.invalid" : process.env.CAFE_TEST_MAIL_FROM?.trim();
      if (!to || !from || !/^[^\s,;<>@]+@[^\s,;<>@]+\.[^\s,;<>@]+$/.test(to)) throw new Error("Set the test mailbox address.");
      const content = await compose(job);
      const {data,error} = await db.rpc("prepare_cafe_test_mail",{p_event:eventId,p_channel:channel,p_payload:{from,to,...content}});
      if (error || !data) throw new Error("Cannot save email for delivery.");
      job = data as Job;
      if (job.status !== "queued") return job.status;
    }
    let providerId = eventId;
    if (job.channel === "resend") {
      // Never reuse a possibly accepted key beyond the provider's 24-hour window.
      if (!job.started_at || Date.now()-Date.parse(job.started_at)>23*3600_000) {
        const {error} = await jobs().update({status:"check_delivery",last_error:"Check provider history before resending."}).eq("event_id",eventId).eq("status","queued");
        if (error) throw new Error("Cannot save mail status.");
        return "check_delivery";
      }
      if (process.env.CAFE_MAIL_MODE !== "resend" || !process.env.RESEND_API_KEY || job.payload?.to !== process.env.CAFE_TEST_MAIL_TO?.trim()) throw new Error("Check test mail configuration.");
      const response = await fetch("https://api.resend.com/emails",{method:"POST",cache:"no-store",
        headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,"Content-Type":"application/json","Idempotency-Key":`cafe-sensor/${eventId}`},
        body:JSON.stringify(job.payload),signal:AbortSignal.timeout(7000)});
      if (!response.ok) throw new Error("Email provider declined the request.");
      const result = await response.json();
      if (typeof result.id !== "string" || !result.id) throw new Error("Email provider response was incomplete.");
      providerId=result.id;
    }
    const status=job.channel==="resend" ? "provider_accepted" : "delivered_to_demo";
    const {error} = await jobs().update({status,provider_id:providerId,sent_at:new Date().toISOString(),last_error:null}).eq("event_id",eventId).eq("status","queued");
    if (error) throw new Error("Cannot save mail status.");
    return status;
  } catch {
    await jobs().update({last_error:"Delivery pending. Check the test mail configuration or retry later.",retry_at:new Date(Date.now()+60000).toISOString()})
      .eq("event_id",eventId).eq("status","queued");
    return "queued";
  }
}

export async function processPendingMail() {
  const {data,error}=await inventoryClient().from("cafe_test_mail").select("event_id").eq("status","queued")
    .lte("retry_at",new Date().toISOString()).order("retry_at").limit(4);
  if(error) throw new Error("Email queue unavailable.");
  return Promise.all((data??[]).map(row=>deliverTestMail(String(row.event_id))));
}
