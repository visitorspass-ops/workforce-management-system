export type BrandDailyAgg = {
  client: string;
  work_date: string;
  order_type: string;
  total_orders: number;
  orders_on_signature_tier: number;
  orders_on_fallback_tier: number;
  actual_minutes: number | null;
  std_minutes_p50: number | null;
  std_minutes_p25: number | null;
  std_minutes_p75: number | null;
  std_minutes_trimmed: number | null;
  unattributed_min: number | null;
  flagged_slow_orders: number;
};

export type PackerDailyAgg = {
  packer_login: string;
  work_date: string;
  order_type: string;
  total_orders: number;
  actual_minutes: number | null;
  std_minutes_p50: number | null;
  unattributed_min: number | null;
  flagged_slow_orders: number;
};

export type PackerHourlyAgg = {
  packer_login: string;
  work_date: string;
  hour_of_day: number;
  order_type: string;
  orders_packed: number;
};

export type NameMappingRow = {
  employee_id: string;
  employee_name: string;
  transaction_user_login: string | null;
  match_status: string | null;
};

export type AttendanceRow = {
  employee_id: string;
  work_date: string;
  employer: string | null; // canonical Employer Agency source
};
