'use strict';

/**
 * Passwort-Prüfungen sind absichtlich rechenintensiv. Liefen sie im Hauptprozess, könnte schon
 * eine Handvoll Anfragen den Server für alle ausbremsen. Deshalb rechnen wenige
 * Hintergrund-Threads, weitere Anfragen warten in einer begrenzten Warteschlange.
 */

const path = require('path');
const { Worker } = require('worker_threads');

function createPasswordPool({ size = 2, maxQueue = 64 } = {}) {
  const slots = [];
  const queue = [];
  let nextId = 1;
  let closed = false;

  function createSlot() {
    const slot = { worker: new Worker(path.join(__dirname, 'password-worker.js')), job: null };
    slot.worker.unref();
    slot.worker.on('message', ({ id, result, error }) => {
      const job = slot.job;
      slot.job = null;
      if (job?.id === id) {
        if (error) job.reject(new Error(error));
        else job.resolve(result);
      }
      pump();
    });
    const replace = failure => {
      const index = slots.indexOf(slot);
      if (index >= 0) slots.splice(index, 1);
      slot.job?.reject(failure);
      slot.job = null;
      if (!closed) pump();
    };
    slot.worker.on('error', error => replace(error));
    slot.worker.on('exit', () => replace(new Error('Der Hintergrund-Thread wurde beendet.')));
    return slot;
  }

  function pump() {
    while (queue.length) {
      let slot = slots.find(item => !item.job);
      if (!slot && slots.length < size) {
        slot = createSlot();
        slots.push(slot);
      }
      if (!slot) return;
      const job = queue.shift();
      slot.job = job;
      slot.worker.postMessage(job.message);
    }
  }

  function run(message) {
    if (closed) return Promise.reject(new Error('Die Passwortprüfung ist beendet.'));
    return new Promise((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      queue.push({ id, resolve, reject, message: { ...message, id } });
      pump();
    });
  }

  return {
    /** Wahr, wenn so viele warten, dass neue Anfragen abgewiesen werden sollten. */
    busy: () => queue.length >= maxQueue,
    compare: (password, hash) => run({ operation: 'compare', password, hash }),
    hash: (password, cost) => run({ operation: 'hash', password, cost }),
    close() {
      closed = true;
      for (const job of queue.splice(0)) job.reject(new Error('Die Passwortprüfung ist beendet.'));
      for (const slot of slots.splice(0)) slot.worker.terminate();
    }
  };
}

module.exports = { createPasswordPool };
