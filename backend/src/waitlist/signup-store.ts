import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "../db/client";
import type { SignupRow, SignupStore } from "./booking";

export function supabaseSignupStore(client: SupabaseClient = serviceClient): SignupStore {
  async function findByEmail(email: string): Promise<SignupRow | null> {
    const { data, error } = await client
      .from("waitlist_signups")
      .select("id,email,profile,attribution")
      .eq("email", email)
      .maybeSingle();
    if (error) throw error;
    return (data as SignupRow | null) ?? null;
  }

  return {
    findByEmail,
    async insertIfNew(row) {
      const { data, error } = await client
        .from("waitlist_signups")
        .upsert(row, { onConflict: "email", ignoreDuplicates: true })
        .select("id");
      if (error) throw error;
      const saved = await findByEmail(row.email);
      if (!saved) throw new Error("Waitlist signup missing after insert");
      return { row: saved, inserted: (data?.length ?? 0) > 0 };
    },
    async updateProfile(id, profile) {
      const { error } = await client.from("waitlist_signups").update({ profile }).eq("id", id);
      if (error) throw error;
    },
  };
}
