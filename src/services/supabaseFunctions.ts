import { supabase } from "@/integrations/supabase/client";

export async function invokeFunction<TRequest, TResponse>(
  name: string,
  body: TRequest
): Promise<TResponse> {
  const { data, error } = await supabase.functions.invoke<TResponse>(name, {
    body,
  });

  if (error) {
    throw new Error(error.message || `Function ${name} failed`);
  }

  return data as TResponse;
}
