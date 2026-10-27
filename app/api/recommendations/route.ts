
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  try {
    const response = await fetch(
      "http://127.0.0.1:8000/recommendations",
      { cache: "no-store" }
    );

    if (!response.ok) {
      throw new Error("Python API returned an error");
    }

    const data = await response.json();

    return NextResponse.json(data);
  } catch (error) {
    console.error("Python API connection failed:", error);

    return NextResponse.json(
      {
        status: "error",
        message: "Could not connect to the Python API",
      },
      { status: 500 }
    );
  }
}
