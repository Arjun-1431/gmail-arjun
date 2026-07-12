"use client";

import axios from "axios";

export const api = axios.create({
  baseURL: "",
  withCredentials: true,
});

export function getErrorMessage(error) {
  return (
    error?.response?.data?.error ||
    error?.response?.data?.details ||
    error?.message ||
    "Something went wrong."
  );
}
