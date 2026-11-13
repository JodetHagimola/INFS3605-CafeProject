import { processPendingMail } from "@/lib/automation/mail";
export async function GET(request: Request) {
  const key=process.env.CRON_SECRET;
  if (!key || request.headers.get("authorization") !== `Bearer ${key}`) return new Response(null,{status:401});
  return Response.json({results:await processPendingMail()},{headers:{"Cache-Control":"no-store"}});
}
