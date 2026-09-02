/**
* Copyright (c) Microsoft Corporation. All rights reserved.
* Licensed under the MIT License.
 */

/* eslint-disable global-require */

import { CatalogUser, TagType, Tags } from './tags';
import templates from '../../static/templates.json';

// *** ADDING DATA TO AZD GALLERY ****/

// Currently using Custom Issues on Repo

// *************** CARD DATA STARTS HERE ***********************
// Add your site to this list
// prettier-ignore

export const bundledCatalogUsers = templates as CatalogUser[];

export const TagList = Object.keys(Tags) as TagType[];
