/**
 * Hand-written applets: test fixtures, demo content for the glasses app when
 * it isn't paired, and the fake model provider's canned output. Typed as input
 * (defaults optional) so they read like what a model writes.
 */
import type { z } from 'zod';
import type { AppletDefinition } from '../schema.ts';

type Input = z.input<typeof AppletDefinition>;

export const rowCounter: Input = {
  formatVersion: 1,
  title: 'Row counter',
  toolPrefix: 'rows',
  summary: 'Counts crochet rows; a pinch adds one.',
  state: [{ id: 'rows', type: 'number', label: 'Rows', default: 0, min: 0, integer: true }],
  actions: [
    {
      id: 'add_row',
      label: 'Add row',
      description: 'Add finished rows to the row counter. Use when the user says they finished a row.',
      args: [{ name: 'count', type: 'integer', description: 'How many rows to add (default 1)', default: 1 }],
      effects: [{ op: 'add', field: 'rows', by: { arg: 'count' } }],
      examples: ['I finished a row', 'add two rows'],
    },
    {
      id: 'undo_row',
      label: 'Undo',
      description: 'Remove rows from the counter, e.g. after a mistake or when the user ripped back.',
      args: [{ name: 'count', type: 'integer', description: 'How many rows to remove (default 1)', default: 1 }],
      effects: [{ op: 'subtract', field: 'rows', by: { arg: 'count' } }],
    },
    {
      id: 'set_rows',
      label: 'Set rows',
      description: 'Set the row counter to an exact number.',
      args: [{ name: 'value', type: 'integer', description: 'The row number', required: true }],
      effects: [{ op: 'set', field: 'rows', value: { arg: 'value' } }],
    },
  ],
  views: [{ id: 'counter', kind: 'value', field: 'rows', label: 'Rows done', actions: ['add_row', 'undo_row'], voiceNote: { label: 'Pattern notes' } }],
  home: { primaryAction: 'add_row' },
};

export const characterSheet: Input = {
  formatVersion: 1,
  title: 'Brakka the Bold',
  toolPrefix: 'dnd',
  summary: 'D&D character: health, spell slots and inventory.',
  state: [
    { id: 'hp', type: 'number', label: 'Health', default: 24, min: 0, max: 24, integer: true },
    { id: 'max_hp', type: 'number', label: 'Max health', default: 24, min: 1, integer: true },
    { id: 'slots', type: 'number', label: 'Spell slots', default: 3, min: 0, max: 3, integer: true },
    {
      id: 'inventory',
      type: 'list',
      label: 'Inventory',
      item: [
        { key: 'name', type: 'string', label: 'Item' },
        { key: 'qty', type: 'number', label: 'Quantity', default: 1 },
      ],
      default: [
        { name: 'Healing potion', qty: 2 },
        { name: 'Rope', qty: 1 },
        { name: 'Torch', qty: 3 },
        { name: 'Dagger', qty: 1 },
      ],
      maxItems: 60,
    },
  ],
  actions: [
    {
      id: 'take_damage',
      label: 'Hit −1',
      description: 'Subtract damage from current health.',
      args: [{ name: 'amount', type: 'integer', description: 'Damage taken (default 1)', default: 1 }],
      effects: [{ op: 'subtract', field: 'hp', by: { arg: 'amount' } }],
    },
    {
      id: 'heal',
      label: 'Heal +1',
      description: 'Add healing to current health (never above max).',
      args: [{ name: 'amount', type: 'integer', description: 'Health regained (default 1)', default: 1 }],
      effects: [{ op: 'add', field: 'hp', by: { arg: 'amount' } }],
    },
    {
      id: 'adjust_max_health',
      label: 'Change max HP',
      description: 'Increase or decrease maximum health, e.g. on level up.',
      args: [{ name: 'delta', type: 'integer', description: 'Change to maximum health; negative to reduce', required: true }],
      effects: [{ op: 'add', field: 'max_hp', by: { arg: 'delta' } }],
    },
    {
      id: 'cast_spell',
      label: 'Cast spell',
      description: 'Use one spell slot.',
      effects: [{ op: 'add', field: 'slots', by: -1 }],
    },
    {
      id: 'long_rest',
      label: 'Long rest',
      description: 'Restore all spell slots and health after a long rest.',
      effects: [{ op: 'reset', field: 'slots' }, { op: 'reset', field: 'hp' }],
    },
    {
      id: 'add_item',
      label: 'Add item',
      description: 'Add an item to the inventory.',
      args: [
        { name: 'name', type: 'string', description: 'Item name', required: true },
        { name: 'qty', type: 'integer', description: 'How many (default 1)', default: 1 },
      ],
      effects: [{ op: 'listAppend', field: 'inventory', item: { name: { arg: 'name' }, qty: { arg: 'qty' } } }],
    },
    {
      id: 'use_item',
      label: 'Use one',
      description: 'Use or lose one of an inventory item (reduces its quantity by one).',
      args: [{ name: 'name', type: 'string', description: 'Item name', required: true }],
      effects: [{ op: 'listAdd', field: 'inventory', match: { key: 'name', equals: { arg: 'name' } }, key: 'qty', by: -1 }],
    },
    {
      id: 'remove_item',
      label: 'Remove item',
      description: 'Remove an item from the inventory entirely.',
      args: [{ name: 'name', type: 'string', description: 'Item name', required: true }],
      effects: [{ op: 'listRemove', field: 'inventory', match: { key: 'name', equals: { arg: 'name' } } }],
    },
  ],
  views: [
    { id: 'health', kind: 'value', title: 'Health', field: 'hp', format: '{hp} / {max_hp}', label: 'HP', actions: ['take_damage', 'heal'] },
    { id: 'spells', kind: 'value', title: 'Spell slots', field: 'slots', label: 'Slots left', actions: ['cast_spell', 'long_rest'] },
    { id: 'bag', kind: 'list', title: 'Inventory', field: 'inventory', display: 'name', detail: 'qty', onSelect: { action: 'use_item', arg: 'name' }, emptyText: 'Your bag is empty.' },
  ],
  home: { entryView: 'health' },
};

export const packingList: Input = {
  formatVersion: 1,
  title: 'Hike packing',
  toolPrefix: 'pack',
  state: [
    {
      id: 'gear',
      type: 'list',
      label: 'Gear',
      item: [
        { key: 'name', type: 'string', label: 'Item' },
        { key: 'packed', type: 'boolean', label: 'Packed', default: false },
      ],
      default: [
        { name: 'Water bottle', packed: false },
        { name: 'Rain jacket', packed: false },
        { name: 'Map', packed: false },
        { name: 'Snacks', packed: false },
        { name: 'First aid kit', packed: false },
      ],
      maxItems: 40,
    },
  ],
  actions: [
    {
      id: 'toggle_item',
      label: 'Pack',
      description: 'Mark an item as packed, or unpacked if it already was.',
      args: [{ name: 'name', type: 'string', description: 'Item name', required: true }],
      effects: [{ op: 'listToggle', field: 'gear', match: { key: 'name', equals: { arg: 'name' } }, key: 'packed' }],
    },
    {
      id: 'add_item',
      label: 'Add item',
      description: 'Add something to the packing list.',
      args: [{ name: 'name', type: 'string', description: 'Item name', required: true }],
      effects: [{ op: 'listAppend', field: 'gear', item: { name: { arg: 'name' } } }],
    },
  ],
  views: [{ id: 'list', kind: 'list', title: 'Pack for the hike', field: 'gear', display: 'name', check: 'packed', onSelect: { action: 'toggle_item', arg: 'name' } }],
};

export const pancakeGuide: Input = {
  formatVersion: 1,
  title: 'Pancakes',
  toolPrefix: 'pancake',
  state: [{ id: 'step', type: 'cursor', label: 'Step', over: 'recipe', default: 0 }],
  actions: [],
  views: [
    {
      id: 'recipe',
      kind: 'sequence',
      cursor: 'step',
      voiceNote: { label: 'Notes on this step' },
      steps: [
        { id: 'mix_dry', text: 'Whisk 200 g flour, 2 tsp baking powder and a pinch of salt.' },
        { id: 'mix_wet', text: 'Beat 2 eggs with 300 ml milk, then stir into the flour until just smooth.' },
        { id: 'heat', text: 'Heat a lightly oiled pan on medium.', hint: 'A drop of water should sizzle' },
        { id: 'cook', text: 'Pour a small ladle. Flip when bubbles pop on top, about 2 minutes.' },
        { id: 'serve', text: 'Cook the other side for 1 minute. Serve warm.' },
      ],
    },
  ],
};

export const FIXTURES = { rowCounter, characterSheet, packingList, pancakeGuide } as const;
