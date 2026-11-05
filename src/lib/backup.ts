import type { Project } from './store';

// Browser storage belongs to one URL and tunnel URLs change, so a project can also travel as a file.
const FORMAT = 'drawar-project';

const toDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

const toBlob = async (url: string) => (await fetch(url)).blob();

export async function exportProject(project: Project): Promise<File> {
  const sheet = project.state?.sheet;
  const payload = {
    format: FORMAT,
    version: 1,
    mode: project.mode,
    image: await toDataUrl(project.image),
    thumb: await toDataUrl(project.thumb),
    state: project.state && {
      ...project.state,
      sheet: sheet && { ...sheet, ink: await toDataUrl(new Blob([sheet.ink.slice().buffer])) },
    },
  };
  // The local date: in the evening the UTC one is already tomorrow.
  const date = new Date(project.updated - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  // A .json name gives phones a type they know: an unknown extension gets greyed out in their
  // file pickers and refused by Android's share sheet.
  return new File([JSON.stringify(payload)], `dibujo-${date}.drawar.json`, { type: 'application/json' });
}

export async function importProject(file: File): Promise<Project> {
  // Some apps that receive a shared file save it as text with a byte order mark in front.
  const data = JSON.parse((await file.text()).replace(/^﻿/, ''));
  if (data.format !== FORMAT) throw new Error('No es un proyecto de DrawAR');
  const sheet = data.state?.sheet;
  return {
    id: Date.now(),
    updated: Date.now(),
    mode: data.mode,
    image: await toBlob(data.image),
    thumb: await toBlob(data.thumb),
    state: data.state && {
      ...data.state,
      sheet: sheet && { ...sheet, ink: new Float32Array(await (await toBlob(sheet.ink)).arrayBuffer()) },
    },
  };
}

// Phones get the share sheet, so the file can go to Drive or WhatsApp; computers download it.
// Only the file is shared: a title or text arrives as a second file in apps like Files or Drive.
export async function deliverFile(file: File): Promise<void> {
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
    }
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(file);
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
}
